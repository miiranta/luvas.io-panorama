import { BlurBackend, cpuBlurBackend } from '../acceleration/blur-backend';
import { CanvasBox } from './canvas-geometry';
import { PyramidLevel, expandLevel, gaussianPyramid } from './pyramid';
import { WarpTile } from './warp-tile';

export interface MosaicView {
    u0: number;
    v0: number;
    canvasWidth: number;
}

export class Mosaic {
    readonly width: number;
    readonly height: number;
    readonly bands: number;
    readonly originU: number;
    readonly originV: number;
    readonly canvasWidth: number;
    readonly bandColor: Float32Array[] = [];
    readonly bandWeight: Float32Array[] = [];
    readonly bandWidth: number[] = [];
    readonly bandHeight: number[] = [];
    readonly flatColor: Float32Array;
    readonly flatWeight: Float32Array;
    readonly coverage: Uint8Array;
    private dirty: CanvasBox | null = null;
    private covered: CanvasBox | null = null;

    constructor(width: number, height: number, bands: number, view?: MosaicView) {
        this.width = width;
        this.height = height;
        this.bands = Math.max(1, bands);
        this.originU = view?.u0 ?? 0;
        this.originV = view?.v0 ?? 0;
        this.canvasWidth = view?.canvasWidth ?? width;
        const n = width * height;
        this.flatColor = new Float32Array(n * 3);
        this.flatWeight = new Float32Array(n);
        this.coverage = new Uint8Array(n);
        for (let level = 0; level < this.bands; level++) {
            const levelWidth = Math.max(1, Math.ceil(width / (1 << level)));
            const levelHeight = Math.max(1, Math.ceil(height / (1 << level)));
            this.bandWidth.push(levelWidth);
            this.bandHeight.push(levelHeight);
            this.bandColor.push(new Float32Array(levelWidth * levelHeight * 3));
            this.bandWeight.push(new Float32Array(levelWidth * levelHeight));
        }
    }

    hasCoverage(index: number): boolean {
        return this.coverage[index] === 1;
    }

    column(rawU: number): number {
        const canvas = this.canvasWidth;
        const absolute = ((rawU % canvas) + canvas) % canvas;
        let local = absolute - this.originU;
        if (local < 0) local += canvas;
        return local < this.width ? local : -1;
    }

    row(rawV: number): number {
        const local = rawV - this.originV;
        return local >= 0 && local < this.height ? local : -1;
    }

    indexAt(rawU: number, rawV: number): number {
        const u = this.column(rawU);
        if (u < 0) return -1;
        const v = this.row(rawV);
        return v < 0 ? -1 : v * this.width + u;
    }

    private levelColumn(level: number, rawU: number): number {
        const canvas = Math.max(1, this.canvasWidth >> level);
        const absolute = ((rawU % canvas) + canvas) % canvas;
        let local = absolute - (this.originU >> level);
        if (local < 0) local += canvas;
        return local < this.bandWidth[level] ? local : -1;
    }

    private levelRow(level: number, rawV: number): number {
        const local = rawV - (this.originV >> level);
        return local >= 0 && local < this.bandHeight[level] ? local : -1;
    }

    markDirty(tile: WarpTile): void {
        const spansWidth = tile.width >= this.width;
        const left = spansWidth ? 0 : Math.max(0, this.column(tile.u0));
        const right = spansWidth ? this.width - 1 : Math.min(this.width - 1, left + tile.width - 1);
        const top = Math.max(0, tile.v0 - this.originV);
        const bottom = Math.min(this.height - 1, tile.v0 + tile.height - 1 - this.originV);
        if (!this.dirty) {
            this.dirty = { u0: left, v0: top, u1: right, v1: bottom };
            return;
        }
        this.dirty.u0 = Math.min(this.dirty.u0, left);
        this.dirty.v0 = Math.min(this.dirty.v0, top);
        this.dirty.u1 = Math.max(this.dirty.u1, right);
        this.dirty.v1 = Math.max(this.dirty.v1, bottom);
    }

    reset(): void {
        if (!this.dirty) return;
        const wrapped = this.dirty.u1 >= this.width;
        const u0 = wrapped ? 0 : Math.max(0, this.dirty.u0);
        const u1 = wrapped ? this.width - 1 : Math.min(this.width - 1, this.dirty.u1);
        const v0 = Math.max(0, this.dirty.v0);
        const v1 = Math.min(this.height - 1, this.dirty.v1);
        const span = u1 - u0 + 1;
        for (let v = v0; v <= v1; v++) {
            const start = v * this.width + u0;
            this.coverage.fill(0, start, start + span);
            this.flatWeight.fill(0, start, start + span);
            this.flatColor.fill(0, start * 3, (start + span) * 3);
        }
        for (let level = 0; level < this.bands; level++) {
            const stride = this.bandWidth[level];
            const levelU0 = u0 >> level;
            const levelU1 = Math.min(stride - 1, u1 >> level);
            const levelSpan = levelU1 - levelU0 + 1;
            if (levelSpan <= 0) continue;
            const levelV1 = Math.min(this.bandHeight[level] - 1, v1 >> level);
            for (let v = v0 >> level; v <= levelV1; v++) {
                const start = v * stride + levelU0;
                this.bandWeight[level].fill(0, start, start + levelSpan);
                this.bandColor[level].fill(0, start * 3, (start + levelSpan) * 3);
            }
        }
        this.dirty = null;
        this.covered = null;
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
        this.markDirty(tile);
        for (let y = 0; y < tile.height; y++) {
            const row = this.row(tile.v0 + y);
            if (row < 0) continue;
            for (let x = 0; x < tile.width; x++) {
                const t = y * tile.width + x;
                const w = tile.mask[t];
                if (w <= 0) continue;
                const column = this.column(tile.u0 + x);
                if (column < 0) continue;
                const index = row * this.width + column;
                this.flatColor[index * 3] += tile.color[t * 3] * w;
                this.flatColor[index * 3 + 1] += tile.color[t * 3 + 1] * w;
                this.flatColor[index * 3 + 2] += tile.color[t * 3 + 2] * w;
                this.flatWeight[index] += w;
                this.coverage[index] = 1;
                if (!this.covered) {
                    this.covered = { u0: column, v0: row, u1: column, v1: row };
                } else {
                    if (column < this.covered.u0) this.covered.u0 = column;
                    if (column > this.covered.u1) this.covered.u1 = column;
                    if (row < this.covered.v0) this.covered.v0 = row;
                    if (row > this.covered.v1) this.covered.v1 = row;
                }
            }
        }
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

    private collapseRegion(overlay: Mosaic | null, box: CanvasBox): PyramidLevel {
        let previous: {
            data: Float32Array;
            u0: number;
            v0: number;
            width: number;
            height: number;
        } | null = null;
        for (let level = this.bands - 1; level >= 0; level--) {
            const stride = this.bandWidth[level];
            const u0 = Math.max(0, (box.u0 >> level) - 1);
            const v0 = Math.max(0, (box.v0 >> level) - 1);
            const u1 = Math.min(stride - 1, (box.u1 >> level) + 1);
            const v1 = Math.min(this.bandHeight[level] - 1, (box.v1 >> level) + 1);
            const width = u1 - u0 + 1;
            const height = v1 - v0 + 1;
            const merged = new Float32Array(width * height * 3);
            if (previous) {
                const coarse = previous;
                for (let y = 0; y < height; y++) {
                    const fy = Math.min(coarse.height - 1, Math.max(0, (v0 + y) * 0.5 - coarse.v0));
                    const y0 = Math.floor(fy);
                    const y1 = Math.min(coarse.height - 1, y0 + 1);
                    const ay = fy - y0;
                    for (let x = 0; x < width; x++) {
                        const fx = Math.min(
                            coarse.width - 1,
                            Math.max(0, (u0 + x) * 0.5 - coarse.u0),
                        );
                        const x0 = Math.floor(fx);
                        const x1 = Math.min(coarse.width - 1, x0 + 1);
                        const ax = fx - x0;
                        const i00 = (y0 * coarse.width + x0) * 3;
                        const i10 = (y0 * coarse.width + x1) * 3;
                        const i01 = (y1 * coarse.width + x0) * 3;
                        const i11 = (y1 * coarse.width + x1) * 3;
                        const w00 = (1 - ax) * (1 - ay);
                        const w10 = ax * (1 - ay);
                        const w01 = (1 - ax) * ay;
                        const w11 = ax * ay;
                        const target = (y * width + x) * 3;
                        for (let c = 0; c < 3; c++) {
                            merged[target + c] =
                                coarse.data[i00 + c] * w00 +
                                coarse.data[i10 + c] * w10 +
                                coarse.data[i01 + c] * w01 +
                                coarse.data[i11 + c] * w11;
                        }
                    }
                }
            }
            const colour = this.bandColor[level];
            const weight = this.bandWeight[level];
            const extraColour = overlay?.bandColor[level] ?? null;
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
                            colour[index * 3 + c] + (extraColour ? extraColour[index * 3 + c] : 0);
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

    render(useBands: boolean, overlay?: Mosaic | null, region?: CanvasBox | null): ImageData {
        const box: CanvasBox = region ?? {
            u0: 0,
            v0: 0,
            u1: this.width - 1,
            v1: this.height - 1,
        };
        const width = box.u1 - box.u0 + 1;
        const height = box.v1 - box.v0 + 1;
        const out = new Uint8ClampedArray(width * height * 4);
        const sameShape =
            overlay !== null &&
            overlay !== undefined &&
            overlay.width === this.width &&
            overlay.height === this.height &&
            overlay.bands === this.bands;
        const extra = sameShape ? (overlay as Mosaic) : null;
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

    boundingBox(overlay?: Mosaic | null): CanvasBox | null {
        const extra =
            overlay && overlay.width === this.width && overlay.height === this.height
                ? overlay.covered
                : null;
        const mine = this.covered;
        if (!mine) return extra ? { ...extra } : null;
        if (!extra) return { ...mine };
        return {
            u0: Math.min(mine.u0, extra.u0),
            v0: Math.min(mine.v0, extra.v0),
            u1: Math.max(mine.u1, extra.u1),
            v1: Math.max(mine.v1, extra.v1),
        };
    }
}
