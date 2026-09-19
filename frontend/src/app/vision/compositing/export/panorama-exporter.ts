import {
    bilinearTaps,
    createBilinearTaps,
    sampleBilinear,
} from '../../foundation/imaging/bilinear';
import { PipelineParams, SurfaceKind } from '../../../core/models/params';
import { BlurBackend } from '../blending/blur-backend';
import { CanvasBox, alignDown, alignUp } from '../warping/canvas-box';
import { CanvasGeometry, createCanvasGeometry } from '../warping/canvas-geometry';
import { CanvasTransfer, canvasTransfer } from '../warping/canvas-transfer';
import {
    Footprint,
    FootprintRequest,
    clipFootprint,
    computeFootprint,
    unionFootprints,
} from '../warping/footprint';
import { MosaicFactory } from '../blending/mosaic-surface';
import { SeamFinder } from '../seams/seam-finder';
import { blendTile } from '../blending/blend-tile';
import { WarpTile } from '../warping/warp-tile';
import { ColorImage } from '../../foundation/imaging/image';
import { LruCache } from '../../foundation/cache/lru-cache';
import { PngWriter } from './png-writer';
import { Mat3 } from '../../foundation/math/matrix3';
import { Keyframe } from '../../pipeline/keyframe';

const EXPORT_MARGIN = 2;
const SEAM_MEGAPIXELS = 2;
const SOURCE_CACHE = 8;
const HALO = 128;
const maskTaps = createBilinearTaps();

export const EXPORT_TILE = 1024;

export interface ExportedImage {
    width: number;
    height: number;
    png: ArrayBuffer;
}

export interface ExportContext {
    params: () => PipelineParams;
    blur: () => BlurBackend;
    createMosaic: MosaicFactory;
    focalAt: (frame: Keyframe, width: number) => number;
    distortion: () => number;
    warpFrame: (
        geometry: CanvasGeometry,
        frame: Keyframe,
        source: ColorImage,
        clip: CanvasBox | null,
    ) => WarpTile | null;
    orientation: () => Mat3;
    surface: () => SurfaceKind;
    report: (stage: string, progress: number) => void;
}

interface SeamMask {
    u0: number;
    v0: number;
    width: number;
    height: number;
    mask: Float32Array;
}

interface ExportPlan {
    geometry: CanvasGeometry;
    low: CanvasGeometry;
    transfer: CanvasTransfer;
    frames: readonly Keyframe[];
    masks: Map<number, SeamMask>;
    footprints: Map<number, Footprint>;
    sources: SourceCache;
}

function grow(box: CanvasBox, margin: number): CanvasBox {
    return {
        u0: box.u0 - margin,
        u1: box.u1 + margin,
        v0: box.v0 - margin,
        v1: box.v1 + margin,
    };
}

class SourceCache {
    private readonly images: LruCache<number, ColorImage>;

    constructor(capacity: number) {
        this.images = new LruCache(capacity);
    }

    async get(frame: Keyframe): Promise<ColorImage | null> {
        const cached = this.images.get(frame.id);
        if (cached) return cached;
        const image = await frame.composeImage();
        if (image) this.images.set(frame.id, image);
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
        context.report('preparing export', 0);
        const sources = new SourceCache(SOURCE_CACHE);
        const usable = frames.filter((frame) => frame.hasComposeSource && frame.composeWidth > 0);
        if (usable.length === 0) return null;
        const reference = usable[0];
        const nativeFocal = context.focalAt(reference, reference.composeWidth);
        const orientation = context.orientation();
        let geometry = exportGeometry(context.surface(), nativeFocal * scale, orientation);
        let box = this.box(geometry, usable);
        if (!box) return null;
        const megapixels = this.megapixels(box);
        if (megapixels > megapixelCap) {
            geometry = exportGeometry(
                context.surface(),
                nativeFocal * scale * Math.sqrt(megapixelCap / megapixels),
                orientation,
            );
            box = this.box(geometry, usable);
            if (!box) return null;
        }
        const lowScale = Math.min(1, Math.sqrt(SEAM_MEGAPIXELS / this.megapixels(box)));
        const low = exportGeometry(context.surface(), geometry.focal * lowScale, orientation);
        const masks = await this.seams(low, usable, sources);
        const plan: ExportPlan = {
            geometry,
            low,
            transfer: canvasTransfer(geometry, low),
            frames: usable,
            masks,
            sources,
            footprints: new Map(
                usable.map((frame) => [frame.id, computeFootprint(geometry, this.request(frame))]),
            ),
        };

        const width = box.u1 - box.u0 + 1;
        const height = box.v1 - box.v0 + 1;
        const writer = new PngWriter(width, height);
        const columns = Math.ceil(width / tileSize);
        const rows = Math.ceil(height / tileSize);
        for (let row = 0; row < rows; row++) {
            const v0 = box.v0 + row * tileSize;
            const v1 = Math.min(box.v1, v0 + tileSize - 1);
            const stripHeight = v1 - v0 + 1;
            const strip = new Uint8ClampedArray(width * stripHeight * 4);
            for (let column = 0; column < columns; column++) {
                context.report('rendering export', (row * columns + column) / (rows * columns));
                const u0 = box.u0 + column * tileSize;
                const u1 = Math.min(box.u1, u0 + tileSize - 1);
                const image = await this.renderTile(plan, { u0, v0, u1, v1 });
                const tileWidth = u1 - u0 + 1;
                for (let y = 0; y < stripHeight; y++) {
                    const from = y * tileWidth * 4;
                    strip.set(
                        image.data.subarray(from, from + tileWidth * 4),
                        (y * width + u0 - box.u0) * 4,
                    );
                }
            }
            await writer.writeRows(strip, stripHeight);
        }
        context.report('encoding export', 1);
        return { width, height, png: await writer.finish() };
    }

    private async renderTile(plan: ExportPlan, core: CanvasBox): Promise<ImageData> {
        const { geometry, low, transfer, masks, footprints, sources } = plan;
        const context = this.context;
        const compose = context.params().compose;
        const region: CanvasBox = {
            u0: alignDown(core.u0 - HALO),
            u1: alignUp(core.u1 + HALO + 1) - 1,
            v0: Math.max(0, alignDown(core.v0 - HALO)),
            v1: Math.min(geometry.height - 1, alignUp(core.v1 + HALO + 1) - 1),
        };
        const mosaic = context.createMosaic(
            Math.min(region.u1 - region.u0 + 1, geometry.width),
            region.v1 - region.v0 + 1,
            compose.bands,
            {
                u0: ((region.u0 % geometry.width) + geometry.width) % geometry.width,
                v0: region.v0,
                canvasWidth: geometry.width,
            },
        );
        for (const frame of plan.frames) {
            const mask = masks.get(frame.id);
            const footprint = footprints.get(frame.id);
            if (!mask || !footprint?.valid) continue;
            if (!clipFootprint(geometry, grow(footprint, HALO), region)) continue;
            const source = await sources.get(frame);
            if (!source) continue;
            const tile = context.warpFrame(geometry, frame, source, region);
            if (!tile) continue;
            this.applySeam(tile, mask, transfer, low);
            blendTile(mosaic, tile, compose.blend, context.blur());
        }
        const image = mosaic.render(compose.blend === 'multiband', null, {
            u0: core.u0 - region.u0,
            v0: core.v0 - region.v0,
            u1: core.u1 - region.u0,
            v1: core.v1 - region.v0,
        });
        mosaic.dispose();
        return image;
    }

    private megapixels(box: CanvasBox): number {
        return ((box.u1 - box.u0 + 1) * (box.v1 - box.v0 + 1)) / 1e6;
    }

    private request(frame: Keyframe): FootprintRequest {
        return {
            rotation: frame.rotation,
            width: frame.composeWidth,
            height: frame.composeHeight,
            focal: this.context.focalAt(frame, frame.composeWidth),
            distortion: this.context.distortion(),
        };
    }

    private box(geometry: CanvasGeometry, frames: readonly Keyframe[]): CanvasBox | null {
        const union = unionFootprints(
            geometry,
            frames.map((frame) => this.request(frame)),
        );
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
        sources: SourceCache,
    ): Promise<Map<number, SeamMask>> {
        const masks = new Map<number, SeamMask>();
        const box = this.box(low, frames);
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
            const tile = this.context.warpFrame(low, frame, source, null);
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
    return sampleBilinear(seam.mask, bilinearTaps(seam.width, seam.height, x, y, maskTaps));
}
