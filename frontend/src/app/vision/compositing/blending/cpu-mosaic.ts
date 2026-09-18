import {
    bilinearTaps,
    createBilinearTaps,
    sampleBilinear,
} from '../../foundation/imaging/bilinear';
import { BlurBackend, cpuBlurBackend } from './blur-backend';
import { CanvasBox } from '../warping/canvas-box';
import { MosaicSurface, MosaicView, TileSnapshot } from './mosaic-surface';
import { MosaicGrid } from './mosaic-grid';
import { PyramidLevel, expandLevel, gaussianPyramid } from './gaussian-pyramid';
import { WarpTile } from '../warping/warp-tile';

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

    addFlat(tile: WarpTile): void {
        this.forEachCovered(tile, (t, row, column) => {
            const w = tile.mask[t];
            const index = row * this.width + column;
            this.flatColor[index * 3] += tile.color[t * 3] * w;
            this.flatColor[index * 3 + 1] += tile.color[t * 3 + 1] * w;
            this.flatColor[index * 3 + 2] += tile.color[t * 3 + 2] * w;
            this.flatWeight[index] += w;
        });
        this.markCoverage(tile);
    }

    private premultiply(tile: WarpTile): Float32Array {
        const n = tile.width * tile.height;
        const base = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) {
            const mask = tile.mask[i];
            base[i * 4] = tile.color[i * 3] * mask;
            base[i * 4 + 1] = tile.color[i * 3 + 1] * mask;
            base[i * 4 + 2] = tile.color[i * 3 + 2] * mask;
            base[i * 4 + 3] = mask;
        }
        return base;
    }

    private accumulateLevel(
        tile: WarpTile,
        level: number,
        current: PyramidLevel,
        next: PyramidLevel | null,
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
                accColor[index * 3] += r * weight;
                accColor[index * 3 + 1] += g * weight;
                accColor[index * 3 + 2] += b * weight;
                accWeight[index] += weight;
            }
        }
    }

    addPyramidBands(tile: WarpTile, blur: BlurBackend = cpuBlurBackend): void {
        const base: PyramidLevel = {
            data: this.premultiply(tile),
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
            this.accumulateLevel(tile, level, current, next);
        }
        this.addFlat(tile);
    }

    private collapseRegion(overlay: CpuMosaic | null, box: CanvasBox): PyramidLevel {
        const taps = createBilinearTaps();
        let previous: {
            data: Float32Array;
            u0: number;
            v0: number;
            width: number;
            height: number;
        } | null = null;
        for (let level = this.bands - 1; level >= 0; level--) {
            const stride = this.bandWidth[level];
            const { u0, v0, u1, v1 } = this.levelRegion(level, box);
            const width = u1 - u0 + 1;
            const height = v1 - v0 + 1;
            const merged = new Float32Array(width * height * 3);
            if (previous) {
                const coarse = previous;
                for (let y = 0; y < height; y++) {
                    for (let x = 0; x < width; x++) {
                        bilinearTaps(
                            coarse.width,
                            coarse.height,
                            (u0 + x) * 0.5 - coarse.u0,
                            (v0 + y) * 0.5 - coarse.v0,
                            taps,
                        );
                        const target = (y * width + x) * 3;
                        for (let c = 0; c < 3; c++) {
                            merged[target + c] = sampleBilinear(coarse.data, taps, 3, c);
                        }
                    }
                }
            }
            const color = this.bandColor[level];
            const weight = this.bandWeight[level];
            const extraColor = overlay?.bandColor[level] ?? null;
            const extraWeight = overlay?.bandWeight[level] ?? null;
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const index = (v0 + y) * stride + u0 + x;
                    const total = weight[index] + (extraWeight ? extraWeight[index] : 0);
                    if (total <= 1e-5) continue;
                    const inverse = 1 / total;
                    const target = (y * width + x) * 3;
                    for (let c = 0; c < 3; c++) {
                        const sum =
                            color[index * 3 + c] + (extraColor ? extraColor[index * 3 + c] : 0);
                        merged[target + c] += sum * inverse;
                    }
                }
            }
            previous = { data: merged, u0, v0, width, height };
        }
        const finest = previous as { data: Float32Array; u0: number; v0: number; width: number };
        const width = box.u1 - box.u0 + 1;
        const height = box.v1 - box.v0 + 1;
        const data = new Float32Array(width * height * 3);
        for (let y = 0; y < height; y++) {
            const from = ((box.v0 + y - finest.v0) * finest.width + (box.u0 - finest.u0)) * 3;
            data.set(finest.data.subarray(from, from + width * 3), y * width * 3);
        }
        return { data, width, height };
    }

    render(
        useBands: boolean,
        overlay?: MosaicSurface | null,
        region?: CanvasBox | null,
    ): ImageData {
        const box = this.regionOrFull(region);
        const width = box.u1 - box.u0 + 1;
        const height = box.v1 - box.v0 + 1;
        const out = new Uint8ClampedArray(width * height * 4);
        const sameShape =
            overlay instanceof CpuMosaic &&
            overlay.width === this.width &&
            overlay.height === this.height &&
            overlay.bands === this.bands;
        const extra = sameShape ? overlay : null;
        const collapsed = useBands ? this.collapseRegion(extra, box).data : null;
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
                    const w = this.flatWeight[i] + (extra ? extra.flatWeight[i] : 0);
                    if (w <= 1e-6) continue;
                    out[o * 4] = (this.flatColor[i * 3] + (extra ? extra.flatColor[i * 3] : 0)) / w;
                    out[o * 4 + 1] =
                        (this.flatColor[i * 3 + 1] + (extra ? extra.flatColor[i * 3 + 1] : 0)) / w;
                    out[o * 4 + 2] =
                        (this.flatColor[i * 3 + 2] + (extra ? extra.flatColor[i * 3 + 2] : 0)) / w;
                }
                out[o * 4 + 3] = 255;
            }
        }
        return new ImageData(out, width, height);
    }
}
