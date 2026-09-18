import { ComposeParams } from '../../../core/models/params';
import { MosaicSurface, TileSnapshot, cellSource } from '../blending/mosaic-surface';
import { WarpTile } from '../warping/warp-tile';

class MinHeap {
    private costs = new Float64Array(1024);
    private indices = new Int32Array(1024);
    private labels = new Int8Array(1024);
    private length = 0;
    cost = 0;
    index = 0;
    label = 0;

    push(cost: number, index: number, label: number): void {
        if (this.length === this.costs.length) this.grow();
        let i = this.length++;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (this.costs[parent] <= cost) break;
            this.costs[i] = this.costs[parent];
            this.indices[i] = this.indices[parent];
            this.labels[i] = this.labels[parent];
            i = parent;
        }
        this.costs[i] = cost;
        this.indices[i] = index;
        this.labels[i] = label;
    }

    pop(): boolean {
        if (this.length === 0) return false;
        this.cost = this.costs[0];
        this.index = this.indices[0];
        this.label = this.labels[0];
        const last = --this.length;
        if (last === 0) return true;
        const cost = this.costs[last];
        const index = this.indices[last];
        const label = this.labels[last];
        let i = 0;
        for (;;) {
            const left = i * 2 + 1;
            if (left >= last) break;
            const right = left + 1;
            const child = right < last && this.costs[right] < this.costs[left] ? right : left;
            if (this.costs[child] >= cost) break;
            this.costs[i] = this.costs[child];
            this.indices[i] = this.indices[child];
            this.labels[i] = this.labels[child];
            i = child;
        }
        this.costs[i] = cost;
        this.indices[i] = index;
        this.labels[i] = label;
        return true;
    }

    private grow(): void {
        const size = this.costs.length * 2;
        const costs = new Float64Array(size);
        const indices = new Int32Array(size);
        const labels = new Int8Array(size);
        costs.set(this.costs);
        indices.set(this.indices);
        labels.set(this.labels);
        this.costs = costs;
        this.indices = indices;
        this.labels = labels;
    }
}

export interface SeamStats {
    overlapPixels: number;
    inconsistentPixels: number;
}

export class SeamFinder {
    constructor(private readonly params: ComposeParams) {}

    cut(mosaic: MosaicSurface, tile: WarpTile, reference: MosaicSurface | null = null): SeamStats {
        const params = this.params;
        const stats: SeamStats = { overlapPixels: 0, inconsistentPixels: 0 };
        const step = this.step(tile);
        const mine = mosaic.snapshot(tile, step);
        const other: TileSnapshot | null = reference ? reference.snapshot(tile, step) : null;
        const width = mine.width;
        const height = mine.height;
        const cells = width * height;
        const overlap = new Uint8Array(cells);
        const difference = new Float32Array(cells);
        const present = new Uint8Array(cells);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const [sx, sy] = cellSource(tile, step, x, y);
                const source = sy * tile.width + sx;
                const cell = y * width + x;
                if (tile.mask[source] <= 0) continue;
                present[cell] = 1;
                const snapshot = mine.filled[cell] ? mine : other?.filled[cell] ? other : null;
                if (!snapshot) continue;
                overlap[cell] = 1;
                stats.overlapPixels += step * step;
                const d =
                    (Math.abs(snapshot.mean[cell * 3] - tile.color[source * 3]) +
                        Math.abs(snapshot.mean[cell * 3 + 1] - tile.color[source * 3 + 1]) +
                        Math.abs(snapshot.mean[cell * 3 + 2] - tile.color[source * 3 + 2])) /
                    3;
                difference[cell] = d;
                if (d > params.deghostThreshold) stats.inconsistentPixels += step * step;
            }
        }
        if (stats.overlapPixels === 0) return stats;
        if (!params.seam) {
            if (params.deghost) {
                this.applyCells(tile, step, width, height, (cell) =>
                    overlap[cell] && difference[cell] > params.deghostThreshold ? 0 : -1,
                );
            }
            return stats;
        }
        const cost = new Float64Array(cells).fill(Number.POSITIVE_INFINITY);
        const label = new Int8Array(cells).fill(-1);
        const heap = new MinHeap();
        for (let cell = 0; cell < cells; cell++) {
            if (overlap[cell]) continue;
            if (present[cell]) {
                cost[cell] = 0;
                label[cell] = 1;
                heap.push(0, cell, 1);
                continue;
            }
            if (mine.covered[cell] || other?.covered[cell]) {
                cost[cell] = 0;
                label[cell] = 0;
                heap.push(0, cell, 0);
            }
        }
        const neighbours = [-1, 1, -width, width];
        while (heap.pop()) {
            const current = heap.index;
            const currentCost = heap.cost;
            const currentLabel = heap.label;
            if (currentCost > cost[current] + 1e-9) continue;
            const x = current % width;
            for (const offset of neighbours) {
                const next = current + offset;
                if (next < 0 || next >= cells) continue;
                if (offset === -1 && x === 0) continue;
                if (offset === 1 && x === width - 1) continue;
                if (!overlap[next]) continue;
                const stepCost = 1 + difference[next] * difference[next];
                const candidate = currentCost + stepCost;
                if (candidate < cost[next]) {
                    cost[next] = candidate;
                    label[next] = currentLabel;
                    heap.push(candidate, next, currentLabel);
                }
            }
        }
        const ramp = Math.max(1, params.featherWidth / 6 / step);
        this.applyCells(tile, step, width, height, (cell, current) => {
            if (!overlap[cell]) return -1;
            if (label[cell] === 0) return 0;
            if (label[cell] === 1) return Math.max(current, Math.min(1, (cost[cell] + 1) / ramp));
            return params.deghost && difference[cell] > params.deghostThreshold ? 0 : -1;
        });
        return stats;
    }

    private step(tile: WarpTile): number {
        const budget = this.params.seamMegapixels;
        if (budget <= 0) return 1;
        const area = tile.width * tile.height;
        if (area <= budget * 1e6) return 1;
        return Math.max(1, Math.round(Math.sqrt(area / (budget * 1e6))));
    }

    private applyCells(
        tile: WarpTile,
        step: number,
        width: number,
        height: number,
        value: (cell: number, current: number) => number,
    ): void {
        for (let y = 0; y < tile.height; y++) {
            const cellRow = Math.min(height - 1, (y / step) | 0) * width;
            for (let x = 0; x < tile.width; x++) {
                const index = y * tile.width + x;
                if (tile.mask[index] <= 0) continue;
                const next = value(cellRow + Math.min(width - 1, (x / step) | 0), tile.mask[index]);
                if (next >= 0) tile.mask[index] = next;
            }
        }
    }
}
