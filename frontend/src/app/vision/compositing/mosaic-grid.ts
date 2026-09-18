import { CanvasBox } from './canvas-geometry';
import { MosaicSurface, MosaicView } from './mosaic-surface';
import { WarpTile } from './warp-tile';

export interface ColumnRun {
    tileStart: number;
    localStart: number;
    length: number;
}

export abstract class MosaicGrid {
    readonly width: number;
    readonly height: number;
    readonly bands: number;
    readonly originU: number;
    readonly originV: number;
    readonly canvasWidth: number;
    readonly bandWidth: number[] = [];
    readonly bandHeight: number[] = [];
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
        this.coverage = new Uint8Array(width * height);
        for (let level = 0; level < this.bands; level++) {
            this.bandWidth.push(Math.max(1, Math.ceil(width / (1 << level))));
            this.bandHeight.push(Math.max(1, Math.ceil(height / (1 << level))));
        }
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

    levelColumn(level: number, rawU: number): number {
        const canvas = Math.max(1, this.canvasWidth >> level);
        const absolute = ((rawU % canvas) + canvas) % canvas;
        let local = absolute - (this.originU >> level);
        if (local < 0) local += canvas;
        return local < this.bandWidth[level] ? local : -1;
    }

    levelRow(level: number, rawV: number): number {
        const local = rawV - (this.originV >> level);
        return local >= 0 && local < this.bandHeight[level] ? local : -1;
    }

    columnRuns(level: number, rawStart: number, count: number): ColumnRun[] {
        const runs: ColumnRun[] = [];
        let current: ColumnRun | null = null;
        for (let x = 0; x < count; x++) {
            const local = this.levelColumn(level, rawStart + x);
            if (local < 0) {
                current = null;
                continue;
            }
            if (current && current.localStart + current.length === local) {
                current.length++;
                continue;
            }
            current = { tileStart: x, localStart: local, length: 1 };
            runs.push(current);
        }
        return runs;
    }

    protected markCoverage(tile: WarpTile): void {
        this.markDirty(tile);
        for (let y = 0; y < tile.height; y++) {
            const row = this.row(tile.v0 + y);
            if (row < 0) continue;
            for (let x = 0; x < tile.width; x++) {
                if (tile.mask[y * tile.width + x] <= 0) continue;
                const column = this.column(tile.u0 + x);
                if (column < 0) continue;
                this.coverage[row * this.width + column] = 1;
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

    private markDirty(tile: WarpTile): void {
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

    protected abstract clearAccumulators(box: CanvasBox): void;

    reset(): void {
        if (!this.dirty) return;
        const wrapped = this.dirty.u1 >= this.width;
        const box: CanvasBox = {
            u0: wrapped ? 0 : Math.max(0, this.dirty.u0),
            u1: wrapped ? this.width - 1 : Math.min(this.width - 1, this.dirty.u1),
            v0: Math.max(0, this.dirty.v0),
            v1: Math.min(this.height - 1, this.dirty.v1),
        };
        const span = box.u1 - box.u0 + 1;
        for (let v = box.v0; v <= box.v1; v++) {
            const start = v * this.width + box.u0;
            this.coverage.fill(0, start, start + span);
        }
        this.clearAccumulators(box);
        this.dirty = null;
        this.covered = null;
    }

    boundingBox(overlay?: MosaicSurface | null): CanvasBox | null {
        const extra =
            overlay instanceof MosaicGrid &&
            overlay.width === this.width &&
            overlay.height === this.height
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

    coveredCount(box: CanvasBox, overlay?: MosaicSurface | null): number {
        const extra =
            overlay instanceof MosaicGrid && overlay.width === this.width ? overlay : null;
        let count = 0;
        for (let v = box.v0; v <= box.v1; v++) {
            for (let u = box.u0; u <= box.u1; u++) {
                const index = v * this.width + u;
                if (this.coverage[index] || extra?.coverage[index]) count++;
            }
        }
        return count;
    }
}
