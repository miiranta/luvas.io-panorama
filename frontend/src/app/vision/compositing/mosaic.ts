import { BlurBackend, cpuBlurBackend } from '../acceleration/blur-backend';
import { CanvasBox } from './canvas-geometry';
import { PyramidLevel, expandLevel, expandRgb, gaussianPyramid } from './pyramid';
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
        const colour = (source: Float32Array, index: number, channel: number): number => {
            const weight = source[index * 4 + 3];
            return weight > 1e-6 ? source[index * 4 + channel] / weight : 0;
        };
        for (let y = 0; y < current.height; y++) {
            const row = this.levelRow(level, baseV + y);
            if (row < 0) continue;
            for (let x = 0; x < current.width; x++) {
                const t = y * current.width + x;
                const weight = current.data[t * 4 + 3];
                if (weight <= 1e-5) continue;
                const column = this.levelColumn(level, baseU + x);
                if (column < 0) continue;
                const index = row * stride + column;
                for (let channel = 0; channel < 3; channel++) {
                    const value = next
                        ? colour(current.data, t, channel) - colour(next.data, t, channel)
                        : colour(current.data, t, channel);
                    accColor[index * 3 + channel] += value * weight;
                }
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

    private collapseBands(overlay: Mosaic | null): Float32Array {
        let current: Float32Array | null = null;
        let currentWidth = 0;
        let currentHeight = 0;
        for (let level = this.bands - 1; level >= 0; level--) {
            const width = this.bandWidth[level];
            const height = this.bandHeight[level];
            const colour = this.bandColor[level];
            const weight = this.bandWeight[level];
            const extraColour = overlay?.bandColor[level] ?? null;
            const extraWeight = overlay?.bandWeight[level] ?? null;
            const merged: Float32Array = current
                ? expandRgb(current, currentWidth, currentHeight, width, height)
                : new Float32Array(width * height * 3);
            for (let i = 0; i < width * height; i++) {
                const total = weight[i] + (extraWeight ? extraWeight[i] : 0);
                if (total <= 1e-5) continue;
                for (let channel = 0; channel < 3; channel++) {
                    const sum =
                        colour[i * 3 + channel] + (extraColour ? extraColour[i * 3 + channel] : 0);
                    merged[i * 3 + channel] += sum / total;
                }
            }
            current = merged;
            currentWidth = width;
            currentHeight = height;
        }
        return current ?? new Float32Array(this.width * this.height * 3);
    }

    render(useBands: boolean, overlay?: Mosaic | null): ImageData {
        const n = this.width * this.height;
        const out = new Uint8ClampedArray(n * 4);
        const sameShape =
            overlay !== null &&
            overlay !== undefined &&
            overlay.width === this.width &&
            overlay.height === this.height &&
            overlay.bands === this.bands;
        const extra = sameShape ? (overlay as Mosaic) : null;
        const collapsed = useBands ? this.collapseBands(extra) : null;
        for (let i = 0; i < n; i++) {
            const covered = this.coverage[i] === 1 || (extra !== null && extra.coverage[i] === 1);
            if (!covered) continue;
            let r = 0;
            let g = 0;
            let b = 0;
            if (collapsed) {
                r = collapsed[i * 3];
                g = collapsed[i * 3 + 1];
                b = collapsed[i * 3 + 2];
            } else {
                const w = this.flatWeight[i] + (extra ? extra.flatWeight[i] : 0);
                if (w <= 1e-6) continue;
                r = (this.flatColor[i * 3] + (extra ? extra.flatColor[i * 3] : 0)) / w;
                g = (this.flatColor[i * 3 + 1] + (extra ? extra.flatColor[i * 3 + 1] : 0)) / w;
                b = (this.flatColor[i * 3 + 2] + (extra ? extra.flatColor[i * 3 + 2] : 0)) / w;
            }
            out[i * 4] = r;
            out[i * 4 + 1] = g;
            out[i * 4 + 2] = b;
            out[i * 4 + 3] = 255;
        }
        return new ImageData(out, this.width, this.height);
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
