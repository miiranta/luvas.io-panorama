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
        const n = tile.width * tile.height;
        const existing = new Float32Array(3);
        const overlap = new Uint8Array(n);
        const difference = new Float32Array(n);
        for (let y = 0; y < tile.height; y++) {
            const cv = tile.v0 + y;
            if (cv < 0 || cv >= mosaic.height) continue;
            for (let x = 0; x < tile.width; x++) {
                const t = y * tile.width + x;
                if (tile.mask[t] <= 0) continue;
                const cu = (((tile.u0 + x) % mosaic.width) + mosaic.width) % mosaic.width;
                const index = cv * mosaic.width + cu;
                if (
                    !mosaic.meanColorAt(index, existing) &&
                    !reference?.meanColorAt(index, existing)
                ) {
                    continue;
                }
                overlap[t] = 1;
                stats.overlapPixels++;
                const d =
                    Math.abs(existing[0] - tile.color[t * 3]) +
                    Math.abs(existing[1] - tile.color[t * 3 + 1]) +
                    Math.abs(existing[2] - tile.color[t * 3 + 2]);
                difference[t] = d / 3;
                if (d / 3 > params.deghostThreshold) stats.inconsistentPixels++;
            }
        }
        if (stats.overlapPixels === 0) return stats;
        if (!params.seam) {
            if (params.deghost) {
                for (let t = 0; t < n; t++) {
                    if (overlap[t] && difference[t] > params.deghostThreshold) tile.mask[t] = 0;
                }
            }
            return stats;
        }
        const cost = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
        const label = new Int8Array(n).fill(-1);
        const heap = new MinHeap();
        for (let y = 0; y < tile.height; y++) {
            const cv = tile.v0 + y;
            for (let x = 0; x < tile.width; x++) {
                const t = y * tile.width + x;
                const inNew = tile.mask[t] > 0;
                if (overlap[t]) continue;
                if (inNew) {
                    cost[t] = 0;
                    label[t] = 1;
                    heap.push({ cost: 0, index: t, label: 1 });
                } else if (cv >= 0 && cv < mosaic.height) {
                    const cu = (((tile.u0 + x) % mosaic.width) + mosaic.width) % mosaic.width;
                    const index = cv * mosaic.width + cu;
                    if (mosaic.hasCoverage(index) || reference?.hasCoverage(index)) {
                        cost[t] = 0;
                        label[t] = 0;
                        heap.push({ cost: 0, index: t, label: 0 });
                    }
                }
            }
        }
        const neighbours = [-1, 1, -tile.width, tile.width];
        while (heap.size > 0) {
            const entry = heap.pop();
            if (!entry) break;
            if (entry.cost > cost[entry.index] + 1e-9) continue;
            const x = entry.index % tile.width;
            for (const step of neighbours) {
                const next = entry.index + step;
                if (next < 0 || next >= n) continue;
                if (step === -1 && x === 0) continue;
                if (step === 1 && x === tile.width - 1) continue;
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
        const ramp = Math.max(1, params.featherWidth / 6);
        for (let t = 0; t < n; t++) {
            if (!overlap[t]) continue;
            if (label[t] === 0) {
                tile.mask[t] = 0;
            } else if (label[t] === 1) {
                tile.mask[t] = Math.max(tile.mask[t], Math.min(1, (cost[t] + 1) / ramp));
            } else if (params.deghost && difference[t] > params.deghostThreshold) {
                tile.mask[t] = 0;
            }
        }
        return stats;
    }
}
