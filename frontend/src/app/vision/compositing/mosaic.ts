import { BlurBackend, cpuBlurBackend } from '../acceleration/blur-backend';
import { CanvasBox } from './canvas-geometry';
import { WarpTile } from './warp-tile';

export class Mosaic {
    readonly width: number;
    readonly height: number;
    readonly bands: number;
    readonly bandColor: Float32Array[] = [];
    readonly bandWeight: Float32Array[] = [];
    readonly flatColor: Float32Array;
    readonly flatWeight: Float32Array;
    readonly coverage: Uint8Array;
    private dirty: CanvasBox | null = null;

    constructor(width: number, height: number, bands: number) {
        this.width = width;
        this.height = height;
        this.bands = Math.max(1, bands);
        const n = width * height;
        this.flatColor = new Float32Array(n * 3);
        this.flatWeight = new Float32Array(n);
        this.coverage = new Uint8Array(n);
        for (let l = 0; l < this.bands; l++) {
            this.bandColor.push(new Float32Array(n * 3));
            this.bandWeight.push(new Float32Array(n));
        }
    }

    hasCoverage(index: number): boolean {
        return this.coverage[index] === 1;
    }

    markDirty(tile: WarpTile): void {
        const spansWidth = tile.width >= this.width;
        const left = spansWidth ? 0 : ((tile.u0 % this.width) + this.width) % this.width;
        const right = spansWidth ? this.width - 1 : left + tile.width - 1;
        const top = Math.max(0, tile.v0);
        const bottom = Math.min(this.height - 1, tile.v0 + tile.height - 1);
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
        const span = u1 - u0 + 1;
        for (
            let v = Math.max(0, this.dirty.v0);
            v <= Math.min(this.height - 1, this.dirty.v1);
            v++
        ) {
            const start = v * this.width + u0;
            this.coverage.fill(0, start, start + span);
            this.flatWeight.fill(0, start, start + span);
            this.flatColor.fill(0, start * 3, (start + span) * 3);
            for (let level = 0; level < this.bands; level++) {
                this.bandWeight[level].fill(0, start, start + span);
                this.bandColor[level].fill(0, start * 3, (start + span) * 3);
            }
        }
        this.dirty = null;
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
            const cv = tile.v0 + y;
            if (cv < 0 || cv >= this.height) continue;
            for (let x = 0; x < tile.width; x++) {
                const t = y * tile.width + x;
                const w = tile.mask[t];
                if (w <= 0) continue;
                const cu = (((tile.u0 + x) % this.width) + this.width) % this.width;
                const index = cv * this.width + cu;
                this.flatColor[index * 3] += tile.color[t * 3] * w;
                this.flatColor[index * 3 + 1] += tile.color[t * 3 + 1] * w;
                this.flatColor[index * 3 + 2] += tile.color[t * 3 + 2] * w;
                this.flatWeight[index] += w;
                this.coverage[index] = 1;
            }
        }
    }

    addBands(tile: WarpTile, baseSigma: number, blur: BlurBackend = cpuBlurBackend): void {
        const n = tile.width * tile.height;
        const base = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) {
            const mask = tile.mask[i];
            base[i * 4] = tile.color[i * 3] * mask;
            base[i * 4 + 1] = tile.color[i * 3 + 1] * mask;
            base[i * 4 + 2] = tile.color[i * 3 + 2] * mask;
            base[i * 4 + 3] = mask;
        }
        const sigmas: number[] = [];
        for (let level = 0; level < this.bands - 1; level++) {
            sigmas.push(baseSigma * Math.pow(2, level));
        }
        const blurred =
            sigmas.length > 0
                ? (blur.blurLevels(base, tile.width, tile.height, sigmas) ??
                  cpuBlurBackend.blurLevels(base, tile.width, tile.height, sigmas))
                : [];
        if (!blurred) return;
        const levels = [base, ...blurred];
        const colour = (level: Float32Array, index: number, channel: number): number => {
            const weight = level[index * 4 + 3];
            return weight > 1e-6 ? level[index * 4 + channel] / weight : 0;
        };

        for (let level = 0; level < this.bands; level++) {
            const current = levels[level];
            const next = level + 1 < levels.length ? levels[level + 1] : null;
            const accColor = this.bandColor[level];
            const accWeight = this.bandWeight[level];
            for (let y = 0; y < tile.height; y++) {
                const cv = tile.v0 + y;
                if (cv < 0 || cv >= this.height) continue;
                for (let x = 0; x < tile.width; x++) {
                    const t = y * tile.width + x;
                    const weight = current[t * 4 + 3];
                    if (weight <= 1e-5) continue;
                    const cu = (((tile.u0 + x) % this.width) + this.width) % this.width;
                    const index = cv * this.width + cu;
                    for (let channel = 0; channel < 3; channel++) {
                        const value = next
                            ? colour(current, t, channel) - colour(next, t, channel)
                            : colour(current, t, channel);
                        accColor[index * 3 + channel] += value * weight;
                    }
                    accWeight[index] += weight;
                }
            }
        }
        this.addFlat(tile);
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
        for (let i = 0; i < n; i++) {
            const covered = this.coverage[i] === 1 || (extra !== null && extra.coverage[i] === 1);
            if (!covered) continue;
            let r = 0;
            let g = 0;
            let b = 0;
            if (useBands) {
                for (let l = 0; l < this.bands; l++) {
                    const w = this.bandWeight[l][i] + (extra ? extra.bandWeight[l][i] : 0);
                    if (w <= 1e-5) continue;
                    r += (this.bandColor[l][i * 3] + (extra ? extra.bandColor[l][i * 3] : 0)) / w;
                    g +=
                        (this.bandColor[l][i * 3 + 1] +
                            (extra ? extra.bandColor[l][i * 3 + 1] : 0)) /
                        w;
                    b +=
                        (this.bandColor[l][i * 3 + 2] +
                            (extra ? extra.bandColor[l][i * 3 + 2] : 0)) /
                        w;
                }
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
                ? overlay
                : null;
        let u0 = this.width;
        let u1 = -1;
        let v0 = this.height;
        let v1 = -1;
        for (let v = 0; v < this.height; v++) {
            for (let u = 0; u < this.width; u++) {
                const index = v * this.width + u;
                if (!this.coverage[index] && !(extra && extra.coverage[index])) continue;
                if (u < u0) u0 = u;
                if (u > u1) u1 = u;
                if (v < v0) v0 = v;
                if (v > v1) v1 = v;
            }
        }
        if (u1 < 0) return null;
        return { u0, v0, u1, v1 };
    }
}
