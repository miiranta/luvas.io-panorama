import {
    bilinearTaps,
    createBilinearTaps,
    sampleBilinear,
} from '../../foundation/imaging/bilinear';
import { BlurBackend, cpuBlurBackend } from './blur-backend';
import { CanvasBox } from '../warping/canvas-box';
import { CompositeMode, MosaicSurface, MosaicView, TileSnapshot } from './mosaic-surface';
import { MosaicGrid } from './mosaic-grid';
import { PyramidLevel, expandLevel, gaussianPyramid } from './gaussian-pyramid';
import { WarpTile, premultipliedTile } from '../warping/warp-tile';

interface RegionBox {
    u0: number;
    v0: number;
    width: number;
    height: number;
}

interface RegionLevel extends RegionBox {
    data: Float32Array;
}

const taps = createBilinearTaps();

function upsampleRegion(coarse: RegionLevel, region: RegionBox): Float32Array {
    const { u0, v0, width, height } = region;
    const merged = new Float32Array(width * height * 3);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const cx = (u0 + x) * 0.5 - coarse.u0;
            const cy = (v0 + y) * 0.5 - coarse.v0;
            bilinearTaps(coarse.width, coarse.height, cx, cy, taps);
            const target = (y * width + x) * 3;
            for (let c = 0; c < 3; c++)
                merged[target + c] = sampleBilinear(coarse.data, taps, 3, c);
        }
    }
    return merged;
}

export class CpuMosaic extends MosaicGrid implements MosaicSurface {
    readonly kind = 'cpu';
    readonly bandColor: Float32Array[] = [];
    readonly bandWeight: Float32Array[] = [];
    readonly flatColor: Float32Array;
    readonly flatWeight: Float32Array;

    constructor(width: number, height: number, bands: number, view?: MosaicView) {
        super(width, height, bands, view);
        const n = width * height;
        this.flatColor = new Float32Array(n * 3);
        this.flatWeight = new Float32Array(n);
        for (let level = 0; level < this.bands; level++) {
            const cells = this.bandWidth[level] * this.bandHeight[level];
            this.bandColor.push(new Float32Array(cells * 3));
            this.bandWeight.push(new Float32Array(cells));
        }
    }

    protected clearAccumulators(box: CanvasBox): void {
        const span = box.u1 - box.u0 + 1;
        for (let v = box.v0; v <= box.v1; v++) {
            const start = v * this.width + box.u0;
            this.flatWeight.fill(0, start, start + span);
            this.flatColor.fill(0, start * 3, (start + span) * 3);
        }
        for (let level = 0; level < this.bands; level++) {
            const stride = this.bandWidth[level];
            const levelU0 = box.u0 >> level;
            const levelU1 = Math.min(stride - 1, box.u1 >> level);
            const levelSpan = levelU1 - levelU0 + 1;
            if (levelSpan <= 0) continue;
            const levelV1 = Math.min(this.bandHeight[level] - 1, box.v1 >> level);
            for (let v = box.v0 >> level; v <= levelV1; v++) {
                const start = v * stride + levelU0;
                this.bandWeight[level].fill(0, start, start + levelSpan);
                this.bandColor[level].fill(0, start * 3, (start + levelSpan) * 3);
            }
        }
    }

    snapshot(tile: WarpTile, step: number): TileSnapshot {
        return this.collectSnapshot(tile, step, (_, index, out) =>
            index >= 0 ? this.meanColorAt(index, out) : false,
        );
    }

    dispose(): void {
        return;
    }

    meanColorAt(index: number, out: Float32Array): boolean {
        const w = this.flatWeight[index];
        if (w <= 1e-6) return false;
        out[0] = this.flatColor[index * 3] / w;
        out[1] = this.flatColor[index * 3 + 1] / w;
        out[2] = this.flatColor[index * 3 + 2] / w;
        return true;
    }

    addFlat(tile: WarpTile, mode: CompositeMode = 'add'): void {
        const over = mode === 'over';
        this.forEachCovered(tile, (t, row, column) => {
            const w = tile.mask[t];
            const keep = over ? 1 - w : 1;
            const index = row * this.width + column;
            this.flatColor[index * 3] = this.flatColor[index * 3] * keep + tile.color[t * 3] * w;
            this.flatColor[index * 3 + 1] =
                this.flatColor[index * 3 + 1] * keep + tile.color[t * 3 + 1] * w;
            this.flatColor[index * 3 + 2] =
                this.flatColor[index * 3 + 2] * keep + tile.color[t * 3 + 2] * w;
            this.flatWeight[index] = this.flatWeight[index] * keep + w;
        });
        this.markCoverage(tile);
    }

    private accumulateLevel(
        tile: WarpTile,
        level: number,
        current: PyramidLevel,
        next: PyramidLevel | null,
        over: boolean,
    ): void {
        const accColor = this.bandColor[level];
        const accWeight = this.bandWeight[level];
        const stride = this.bandWidth[level];
        const baseU = tile.u0 >> level;
        const baseV = tile.v0 >> level;
        const source = current.data;
        const coarse = next ? next.data : null;
        for (let y = 0; y < current.height; y++) {
            const row = this.levelRow(level, baseV + y);
            if (row < 0) continue;
            const rowStart = row * stride;
            for (let x = 0; x < current.width; x++) {
                const t = (y * current.width + x) * 4;
                const weight = source[t + 3];
                if (weight <= 1e-5) continue;
                const column = this.levelColumn(level, baseU + x);
                if (column < 0) continue;
                const inverse = 1 / weight;
                let r = source[t] * inverse;
                let g = source[t + 1] * inverse;
                let b = source[t + 2] * inverse;
                if (coarse) {
                    const coarseWeight = coarse[t + 3];
                    if (coarseWeight > 1e-6) {
                        const coarseInverse = 1 / coarseWeight;
                        r -= coarse[t] * coarseInverse;
                        g -= coarse[t + 1] * coarseInverse;
                        b -= coarse[t + 2] * coarseInverse;
                    }
                }
                const index = rowStart + column;
                const keep = over ? 1 - weight : 1;
                accColor[index * 3] = accColor[index * 3] * keep + r * weight;
                accColor[index * 3 + 1] = accColor[index * 3 + 1] * keep + g * weight;
                accColor[index * 3 + 2] = accColor[index * 3 + 2] * keep + b * weight;
                accWeight[index] = accWeight[index] * keep + weight;
            }
        }
    }

    addPyramidBands(
        tile: WarpTile,
        blur: BlurBackend = cpuBlurBackend,
        mode: CompositeMode = 'add',
    ): void {
        const base: PyramidLevel = {
            data: premultipliedTile(tile),
            width: tile.width,
            height: tile.height,
        };
        const pyramid = blur.reduceLevels(base, this.bands) ?? gaussianPyramid(base, this.bands);
        for (let level = 0; level < this.bands; level++) {
            const current = pyramid[level];
            const coarser = level + 1 < pyramid.length ? pyramid[level + 1] : null;
            const next =
                coarser && coarser !== current
                    ? expandLevel(coarser, current.width, current.height)
                    : null;
            this.accumulateLevel(tile, level, current, next, mode === 'over');
        }
        this.addFlat(tile, mode);
    }

    private collapseRegion(overlay: CpuMosaic | null, box: CanvasBox, over: boolean): PyramidLevel {
        let previous: RegionLevel | null = null;
        for (let level = this.bands - 1; level >= 0; level--) {
            const { u0, v0, u1, v1 } = this.levelRegion(level, box);
            const region = { u0, v0, width: u1 - u0 + 1, height: v1 - v0 + 1 };
            const merged: Float32Array = previous
                ? upsampleRegion(previous, region)
                : new Float32Array(region.width * region.height * 3);
            this.addBand(level, overlay, region, merged, over);
            previous = { data: merged, ...region };
        }
        const finest = previous as RegionLevel;
        const width = box.u1 - box.u0 + 1;
        const height = box.v1 - box.v0 + 1;
        const data = new Float32Array(width * height * 3);
        for (let y = 0; y < height; y++) {
            const from = ((box.v0 + y - finest.v0) * finest.width + (box.u0 - finest.u0)) * 3;
            data.set(finest.data.subarray(from, from + width * 3), y * width * 3);
        }
        return { data, width, height };
    }

    private addBand(
        level: number,
        overlay: CpuMosaic | null,
        region: RegionBox,
        merged: Float32Array,
        over: boolean,
    ): void {
        const stride = this.bandWidth[level];
        const color = this.bandColor[level];
        const weight = this.bandWeight[level];
        const extraColor = overlay?.bandColor[level] ?? null;
        const extraWeight = overlay?.bandWeight[level] ?? null;
        const { u0, v0, width, height } = region;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const index = (v0 + y) * stride + u0 + x;
                const extra = extraWeight ? extraWeight[index] : 0;
                const keep = over ? 1 - extra : 1;
                const total = weight[index] * keep + extra;
                if (total <= 1e-5) continue;
                const inverse = 1 / total;
                const target = (y * width + x) * 3;
                for (let c = 0; c < 3; c++) {
                    const sum =
                        color[index * 3 + c] * keep + (extraColor ? extraColor[index * 3 + c] : 0);
                    merged[target + c] += sum * inverse;
                }
            }
        }
    }

    render(
        useBands: boolean,
        overlay?: MosaicSurface | null,
        region?: CanvasBox | null,
        mode: CompositeMode = 'add',
    ): ImageData {
        const box = this.regionOrFull(region);
        const width = box.u1 - box.u0 + 1;
        const height = box.v1 - box.v0 + 1;
        const out = new Uint8ClampedArray(width * height * 4);
        const extra = overlay instanceof CpuMosaic && this.sameGrid(overlay) ? overlay : null;
        const over = mode === 'over';
        const collapsed = useBands ? this.collapseRegion(extra, box, over).data : null;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = (box.v0 + y) * this.width + box.u0 + x;
                const o = y * width + x;
                const covered =
                    this.coverage[i] === 1 || (extra !== null && extra.coverage[i] === 1);
                if (!covered) continue;
                if (collapsed) {
                    out[o * 4] = collapsed[o * 3];
                    out[o * 4 + 1] = collapsed[o * 3 + 1];
                    out[o * 4 + 2] = collapsed[o * 3 + 2];
                } else {
                    const extraWeight = extra ? extra.flatWeight[i] : 0;
                    const keep = over ? 1 - extraWeight : 1;
                    const w = this.flatWeight[i] * keep + extraWeight;
                    if (w <= 1e-6) continue;
                    for (let c = 0; c < 3; c++) {
                        const own = this.flatColor[i * 3 + c] * keep;
                        out[o * 4 + c] = (own + (extra ? extra.flatColor[i * 3 + c] : 0)) / w;
                    }
                }
                out[o * 4 + 3] = 255;
            }
        }
        return new ImageData(out, width, height);
    }
}
