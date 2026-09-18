import { ComposeParams } from '../../core/models/params';
import { Mosaic } from './mosaic';
import { WarpTile } from './warp-tile';

interface HeapEntry {
    cost: number;
    index: number;
    label: number;
}

class MinHeap {
    private readonly items: HeapEntry[] = [];

    get size(): number {
        return this.items.length;
    }

    push(entry: HeapEntry): void {
        this.items.push(entry);
        let i = this.items.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (this.items[parent].cost <= this.items[i].cost) break;
            const tmp = this.items[parent];
            this.items[parent] = this.items[i];
            this.items[i] = tmp;
            i = parent;
        }
    }

    pop(): HeapEntry | undefined {
        const top = this.items[0];
        const last = this.items.pop();
        if (this.items.length > 0 && last) {
            this.items[0] = last;
            let i = 0;
            for (;;) {
                const left = i * 2 + 1;
                const right = left + 1;
                let best = i;
                if (left < this.items.length && this.items[left].cost < this.items[best].cost)
                    best = left;
                if (right < this.items.length && this.items[right].cost < this.items[best].cost) {
                    best = right;
                }
                if (best === i) break;
                const tmp = this.items[best];
                this.items[best] = this.items[i];
                this.items[i] = tmp;
                i = best;
            }
        }
        return top;
    }
}

export interface SeamStats {
    overlapPixels: number;
    inconsistentPixels: number;
}

export class SeamFinder {
    constructor(private readonly params: ComposeParams) {}

    cut(mosaic: Mosaic, tile: WarpTile, reference: Mosaic | null = null): SeamStats {
        const params = this.params;
        const stats: SeamStats = { overlapPixels: 0, inconsistentPixels: 0 };
        const step = this.step(tile);
        const width = Math.max(1, Math.ceil(tile.width / step));
        const height = Math.max(1, Math.ceil(tile.height / step));
        const cells = width * height;
        const existing = new Float32Array(3);
        const overlap = new Uint8Array(cells);
        const difference = new Float32Array(cells);
        const present = new Uint8Array(cells);
        for (let y = 0; y < height; y++) {
            const sy = Math.min(tile.height - 1, y * step + (step >> 1));
            for (let x = 0; x < width; x++) {
                const sx = Math.min(tile.width - 1, x * step + (step >> 1));
                const source = sy * tile.width + sx;
                const cell = y * width + x;
                if (tile.mask[source] <= 0) continue;
                present[cell] = 1;
                const index = mosaic.indexAt(tile.u0 + sx, tile.v0 + sy);
                if (index < 0) continue;
                if (
                    !mosaic.meanColorAt(index, existing) &&
                    !reference?.meanColorAt(index, existing)
                ) {
                    continue;
                }
                overlap[cell] = 1;
                stats.overlapPixels += step * step;
                const d =
                    (Math.abs(existing[0] - tile.color[source * 3]) +
                        Math.abs(existing[1] - tile.color[source * 3 + 1]) +
                        Math.abs(existing[2] - tile.color[source * 3 + 2])) /
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
        for (let y = 0; y < height; y++) {
            const sy = Math.min(tile.height - 1, y * step + (step >> 1));
            for (let x = 0; x < width; x++) {
                const cell = y * width + x;
                if (overlap[cell]) continue;
                if (present[cell]) {
                    cost[cell] = 0;
                    label[cell] = 1;
                    heap.push({ cost: 0, index: cell, label: 1 });
                    continue;
                }
                const sx = Math.min(tile.width - 1, x * step + (step >> 1));
                const index = mosaic.indexAt(tile.u0 + sx, tile.v0 + sy);
                if (index < 0) continue;
                if (mosaic.hasCoverage(index) || reference?.hasCoverage(index)) {
                    cost[cell] = 0;
                    label[cell] = 0;
                    heap.push({ cost: 0, index: cell, label: 0 });
                }
            }
        }
        const neighbours = [-1, 1, -width, width];
        while (heap.size > 0) {
            const entry = heap.pop();
            if (!entry) break;
            if (entry.cost > cost[entry.index] + 1e-9) continue;
            const x = entry.index % width;
            for (const offset of neighbours) {
                const next = entry.index + offset;
                if (next < 0 || next >= cells) continue;
                if (offset === -1 && x === 0) continue;
                if (offset === 1 && x === width - 1) continue;
                if (!overlap[next]) continue;
                const stepCost = 1 + difference[next] * difference[next];
                const candidate = entry.cost + stepCost;
                if (candidate < cost[next]) {
                    cost[next] = candidate;
                    label[next] = entry.label;
                    heap.push({ cost: candidate, index: next, label: entry.label });
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
