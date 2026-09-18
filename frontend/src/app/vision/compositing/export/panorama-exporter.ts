import { PipelineParams, SurfaceKind } from '../../../core/models/params';
import { BlurBackend } from '../blending/blur-backend';
import { WarpBackend } from '../warping/warp-backend';
import { CanvasBox, alignDown, alignUp } from '../warping/canvas-box';
import { CanvasGeometry, createCanvasGeometry } from '../warping/canvas-geometry';
import { CanvasTransfer, canvasTransfer } from '../warping/canvas-transfer';
import { clipFootprint, computeFootprint, unionFootprints } from '../warping/footprint';
import { MosaicFactory } from '../blending/mosaic-surface';
import { SeamFinder } from '../seams/seam-finder';
import { Warper } from '../warping/warper';
import { WarpTile } from '../warping/warp-tile';
import { ColorImage } from '../../foundation/imaging/image';
import { PngWriter } from './png-writer';
import { Mat3 } from '../../foundation/math/matrix3';
import { Keyframe } from '../../pipeline/keyframe';

const EXPORT_MARGIN = 2;
const SEAM_MEGAPIXELS = 2;
const SOURCE_CACHE = 8;
const HALO = 128;

export const EXPORT_TILE = 1024;

export interface ExportedImage {
    width: number;
    height: number;
    png: ArrayBuffer;
}

export interface ExportContext {
    params: () => PipelineParams;
    blur: () => BlurBackend;
    warp: () => WarpBackend;
    createMosaic: MosaicFactory;
    focalFor: (frame: Keyframe) => number;
    distortion: () => number;
    vignetting: () => number;
    orientation: () => Mat3;
    report: (stage: string, progress: number) => void;
}

interface SourceSize {
    width: number;
    height: number;
}

interface SeamMask {
    u0: number;
    v0: number;
    width: number;
    height: number;
    mask: Float32Array;
}

class SourceCache {
    private readonly images = new Map<number, ColorImage>();

    constructor(private readonly capacity: number) {}

    async get(frame: Keyframe): Promise<ColorImage | null> {
        const cached = this.images.get(frame.id);
        if (cached) {
            this.images.delete(frame.id);
            this.images.set(frame.id, cached);
            return cached;
        }
        const image = await frame.composeImage();
        if (!image) return null;
        this.images.set(frame.id, image);
        if (this.images.size > this.capacity) {
            const oldest = this.images.keys().next().value as number;
            this.images.delete(oldest);
        }
        return image;
    }
}

function exportGeometry(surface: SurfaceKind, focal: number, orientation: Mat3): CanvasGeometry {
    const width =
        surface === 'planar'
            ? Math.round(focal * 2.4)
            : Math.round(Math.PI * 2 * Math.max(1, focal));
    return createCanvasGeometry(surface, Math.max(64, width), focal, orientation);
}

export class PanoramaExporter {
    constructor(private readonly context: ExportContext) {}

    async render(
        frames: readonly Keyframe[],
        scale: number,
        megapixelCap: number,
        tileSize = EXPORT_TILE,
    ): Promise<ExportedImage | null> {
        const context = this.context;
        const params = context.params();
        const compose = params.compose;
        context.report('preparing export', 0);
        const sources = new SourceCache(SOURCE_CACHE);
        const usable = frames.filter((frame) => frame.hasComposeSource && frame.composeWidth > 0);
        const sizes = new Map<number, SourceSize>(
            usable.map((frame) => [
                frame.id,
                { width: frame.composeWidth, height: frame.composeHeight },
            ]),
        );
        if (usable.length === 0) return null;
        const reference = usable[0];
        const referenceSize = sizes.get(reference.id) as SourceSize;
        const nativeFocal =
            context.focalFor(reference) * (referenceSize.width / reference.workWidth);
        const orientation = context.orientation();
        let geometry = exportGeometry(compose.surface, nativeFocal * scale, orientation);
        let box = this.box(geometry, usable, sizes);
        if (!box) return null;
        const megapixels = this.megapixels(box);
        if (megapixels > megapixelCap) {
            geometry = exportGeometry(
                compose.surface,
                nativeFocal * scale * Math.sqrt(megapixelCap / megapixels),
                orientation,
            );
            box = this.box(geometry, usable, sizes);
            if (!box) return null;
        }
        const lowScale = Math.min(1, Math.sqrt(SEAM_MEGAPIXELS / this.megapixels(box)));
        const low = exportGeometry(compose.surface, geometry.focal * lowScale, orientation);
        const masks = await this.seams(low, usable, sizes, sources);
        const transfer = canvasTransfer(geometry, low);

        const width = box.u1 - box.u0 + 1;
        const height = box.v1 - box.v0 + 1;
        const writer = new PngWriter(width, height);
        const columns = Math.ceil(width / tileSize);
        const rows = Math.ceil(height / tileSize);
        const useBands = compose.blend === 'multiband';
        const footprints = new Map(
            usable.map((frame) => {
                const size = sizes.get(frame.id) as SourceSize;
                return [
                    frame.id,
                    computeFootprint(
                        geometry,
                        frame.rotation,
                        size.width,
                        size.height,
                        context.focalFor(frame) * (size.width / frame.workWidth),
                        context.distortion(),
                    ),
                ];
            }),
        );
        let done = 0;
        for (let row = 0; row < rows; row++) {
            const coreV0 = box.v0 + row * tileSize;
            const coreV1 = Math.min(box.v1, coreV0 + tileSize - 1);
            const stripHeight = coreV1 - coreV0 + 1;
            const strip = new Uint8ClampedArray(width * stripHeight * 4);
            for (let column = 0; column < columns; column++) {
                context.report('rendering export', done / (rows * columns));
                const coreU0 = box.u0 + column * tileSize;
                const coreU1 = Math.min(box.u1, coreU0 + tileSize - 1);
                const region: CanvasBox = {
                    u0: alignDown(coreU0 - HALO),
                    u1: alignUp(coreU1 + HALO + 1) - 1,
                    v0: Math.max(0, alignDown(coreV0 - HALO)),
                    v1: Math.min(geometry.height - 1, alignUp(coreV1 + HALO + 1) - 1),
                };
                const regionWidth = Math.min(region.u1 - region.u0 + 1, geometry.width);
                const mosaic = context.createMosaic(
                    regionWidth,
                    region.v1 - region.v0 + 1,
                    compose.bands,
                    {
                        u0: ((region.u0 % geometry.width) + geometry.width) % geometry.width,
                        v0: region.v0,
                        canvasWidth: geometry.width,
                    },
                );
                for (const frame of usable) {
                    const mask = masks.get(frame.id);
                    const footprint = footprints.get(frame.id);
                    if (!mask || !footprint?.valid) continue;
                    const reach = {
                        u0: footprint.u0 - HALO,
                        u1: footprint.u1 + HALO,
                        v0: footprint.v0 - HALO,
                        v1: footprint.v1 + HALO,
                    };
                    if (!clipFootprint(geometry, reach, region)) continue;
                    const source = await sources.get(frame);
                    if (!source) continue;
                    const tile = new Warper(geometry, compose, context.warp()).warp(
                        frame.rotation,
                        source,
                        context.focalFor(frame) * (source.width / frame.workWidth),
                        frame.gain,
                        context.distortion(),
                        context.vignetting(),
                        region,
                    );
                    if (!tile) continue;
                    this.applySeam(tile, mask, transfer, low);
                    if (compose.blend === 'average') {
                        for (let i = 0; i < tile.mask.length; i++) {
                            tile.mask[i] = tile.mask[i] > 0 ? 1 : 0;
                        }
                    }
                    if (useBands) mosaic.addPyramidBands(tile, context.blur());
                    else mosaic.addFlat(tile);
                }
                const image = mosaic.render(useBands, null, {
                    u0: coreU0 - region.u0,
                    v0: coreV0 - region.v0,
                    u1: coreU1 - region.u0,
                    v1: coreV1 - region.v0,
                });
                mosaic.dispose();
                const tileWidth = coreU1 - coreU0 + 1;
                const offset = coreU0 - box.u0;
                for (let y = 0; y < stripHeight; y++) {
                    const from = y * tileWidth * 4;
                    strip.set(
                        image.data.subarray(from, from + tileWidth * 4),
                        (y * width + offset) * 4,
                    );
                }
                done++;
            }
            await writer.writeRows(strip, stripHeight);
        }
        context.report('encoding export', 1);
        return { width, height, png: await writer.finish() };
    }

    private megapixels(box: CanvasBox): number {
        return ((box.u1 - box.u0 + 1) * (box.v1 - box.v0 + 1)) / 1e6;
    }

    private box(
        geometry: CanvasGeometry,
        frames: readonly Keyframe[],
        sizes: ReadonlyMap<number, SourceSize>,
    ): CanvasBox | null {
        const requests = frames.map((frame) => {
            const size = sizes.get(frame.id) as SourceSize;
            return {
                rotation: frame.rotation,
                width: size.width,
                height: size.height,
                focal: this.context.focalFor(frame) * (size.width / frame.workWidth),
                distortion: this.context.distortion(),
            };
        });
        const union = unionFootprints(geometry, requests);
        if (!union) return null;
        if (union.u1 - union.u0 + 1 >= geometry.width) {
            return {
                u0: 0,
                u1: geometry.width - 1,
                v0: Math.max(0, alignDown(union.v0 - EXPORT_MARGIN)),
                v1: Math.min(geometry.height - 1, alignUp(union.v1 + EXPORT_MARGIN + 1) - 1),
            };
        }
        return {
            u0: alignDown(union.u0 - EXPORT_MARGIN),
            v0: Math.max(0, alignDown(union.v0 - EXPORT_MARGIN)),
            u1: Math.min(
                alignDown(union.u0 - EXPORT_MARGIN) + geometry.width - 1,
                alignUp(union.u1 + EXPORT_MARGIN + 1) - 1,
            ),
            v1: Math.min(geometry.height - 1, alignUp(union.v1 + EXPORT_MARGIN + 1) - 1),
        };
    }

    private async seams(
        low: CanvasGeometry,
        frames: readonly Keyframe[],
        sizes: ReadonlyMap<number, SourceSize>,
        sources: SourceCache,
    ): Promise<Map<number, SeamMask>> {
        const masks = new Map<number, SeamMask>();
        const box = this.box(low, frames, sizes);
        if (!box) return masks;
        const compose = this.context.params().compose;
        const mosaic = this.context.createMosaic(
            Math.min(box.u1 - box.u0 + 1, low.width),
            box.v1 - box.v0 + 1,
            1,
            {
                u0: ((box.u0 % low.width) + low.width) % low.width,
                v0: box.v0,
                canvasWidth: low.width,
            },
        );
        const finder = new SeamFinder(compose);
        let done = 0;
        for (const frame of frames) {
            this.context.report('planning seams', done / frames.length);
            done++;
            const source = await sources.get(frame);
            if (!source) continue;
            const tile = new Warper(low, compose, this.context.warp()).warp(
                frame.rotation,
                source,
                this.context.focalFor(frame) * (source.width / frame.workWidth),
                frame.gain,
                this.context.distortion(),
                this.context.vignetting(),
            );
            if (!tile) continue;
            finder.cut(mosaic, tile, null);
            mosaic.addFlat(tile);
            masks.set(frame.id, {
                u0: tile.u0,
                v0: tile.v0,
                width: tile.width,
                height: tile.height,
                mask: tile.mask,
            });
        }
        mosaic.dispose();
        return masks;
    }

    private applySeam(
        tile: WarpTile,
        seam: SeamMask,
        transfer: CanvasTransfer,
        low: CanvasGeometry,
    ): void {
        const wraps = low.surface !== 'planar';
        for (let y = 0; y < tile.height; y++) {
            const lowV = transfer.scaleV * (tile.v0 + y + 0.5) + transfer.offsetV - 0.5 - seam.v0;
            for (let x = 0; x < tile.width; x++) {
                const index = y * tile.width + x;
                if (tile.mask[index] <= 0) continue;
                let lowU = transfer.scaleU * (tile.u0 + x + 0.5) + transfer.offsetU - 0.5 - seam.u0;
                if (wraps) {
                    while (lowU < -1) lowU += low.width;
                    while (lowU > seam.width) lowU -= low.width;
                }
                tile.mask[index] = sampleMask(seam, lowU, lowV);
            }
        }
    }
}

function sampleMask(seam: SeamMask, x: number, y: number): number {
    if (x < -1 || y < -1 || x > seam.width || y > seam.height) return 0;
    const cx = Math.min(seam.width - 1, Math.max(0, x));
    const cy = Math.min(seam.height - 1, Math.max(0, y));
    const x0 = Math.floor(cx);
    const y0 = Math.floor(cy);
    const x1 = Math.min(seam.width - 1, x0 + 1);
    const y1 = Math.min(seam.height - 1, y0 + 1);
    const ax = cx - x0;
    const ay = cy - y0;
    const top = seam.mask[y0 * seam.width + x0] * (1 - ax) + seam.mask[y0 * seam.width + x1] * ax;
    const bottom =
        seam.mask[y1 * seam.width + x0] * (1 - ax) + seam.mask[y1 * seam.width + x1] * ax;
    return top * (1 - ay) + bottom * ay;
}
