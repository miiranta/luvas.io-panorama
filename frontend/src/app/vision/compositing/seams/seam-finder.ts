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

function forEachNeighbor(
    cell: number,
    width: number,
    cells: number,
    visit: (neighbor: number) => void,
): void {
    const x = cell % width;
    if (x > 0) visit(cell - 1);
    if (x < width - 1) visit(cell + 1);
    if (cell >= width) visit(cell - width);
    if (cell + width < cells) visit(cell + width);
}

function seamDistance(
    label: Int8Array,
    overlap: Uint8Array,
    width: number,
    cells: number,
): Float64Array {
    const distance = new Float64Array(cells).fill(Number.POSITIVE_INFINITY);
    const queue = new Int32Array(cells);
    let head = 0;
    let tail = 0;
    for (let cell = 0; cell < cells; cell++) {
        if (!overlap[cell] || label[cell] !== 0) continue;
        distance[cell] = 0;
        queue[tail++] = cell;
    }
    while (head < tail) {
        const current = queue[head++];
        const next = distance[current] + 1;
        forEachNeighbor(current, width, cells, (neighbor) => {
            if (!overlap[neighbor] || label[neighbor] !== 1 || distance[neighbor] <= next) return;
            distance[neighbor] = next;
            queue[tail++] = neighbor;
        });
    }
    return distance;
}

function growLabels(
    mine: TileSnapshot,
    other: TileSnapshot | null,
    overlap: Uint8Array,
    present: Uint8Array,
    difference: Float32Array,
): Int8Array {
    const cells = mine.width * mine.height;
    const cost = new Float64Array(cells).fill(Number.POSITIVE_INFINITY);
    const label = new Int8Array(cells).fill(-1);
    const heap = new MinHeap();
    for (let cell = 0; cell < cells; cell++) {
        if (overlap[cell]) continue;
        const seed = present[cell] ? 1 : mine.covered[cell] || other?.covered[cell] ? 0 : -1;
        if (seed < 0) continue;
        cost[cell] = 0;
        label[cell] = seed;
        heap.push(0, cell, seed);
    }
    while (heap.pop()) {
        const current = heap.index;
        const currentCost = heap.cost;
        const currentLabel = heap.label;
        if (currentCost > cost[current] + 1e-9) continue;
        forEachNeighbor(current, mine.width, cells, (next) => {
            if (!overlap[next]) return;
            const candidate = currentCost + (1 + difference[next] * difference[next]);
            if (candidate < cost[next]) {
                cost[next] = candidate;
                label[next] = currentLabel;
                heap.push(candidate, next, currentLabel);
            }
        });
    }
    return label;
}

export interface SeamStats {
    overlapPixels: number;
    inconsistentPixels: number;
}

export class SeamFinder {
    constructor(private readonly params: ComposeParams) {}

    cut(mosaic: MosaicSurface, tile: WarpTile, reference: MosaicSurface | null = null): SeamStats {
        const params = this.params;
        const step = this.step(tile);
        const mine = mosaic.snapshot(tile, step);
        const other = reference ? reference.snapshot(tile, step) : null;
        const { width, height } = mine;
        const { stats, overlap, difference, present } = this.measureOverlap(
            tile,
            step,
            mine,
            other,
        );
        const ghost = (cell: number) =>
            params.deghost && difference[cell] > params.deghostThreshold ? 0 : -1;
        if (stats.overlapPixels === 0) return stats;
        if (!params.seam) {
            if (params.deghost) {
                this.applyCells(tile, step, width, height, (cell) =>
                    overlap[cell] ? ghost(cell) : -1,
                );
            }
            return stats;
        }
        const label = growLabels(mine, other, overlap, present, difference);
        const ramp = Math.max(1, params.featherWidth / 6 / step);
        const distance = seamDistance(label, overlap, width, width * height);
        this.applyCells(tile, step, width, height, (cell, current) => {
            if (!overlap[cell]) return -1;
            if (label[cell] === 0) return 0;
            if (label[cell] === 1) return Math.min(current, distance[cell] / ramp);
            return ghost(cell);
        });
        return stats;
    }

    private measureOverlap(
        tile: WarpTile,
        step: number,
        mine: TileSnapshot,
        other: TileSnapshot | null,
    ): { stats: SeamStats; overlap: Uint8Array; difference: Float32Array; present: Uint8Array } {
        const stats: SeamStats = { overlapPixels: 0, inconsistentPixels: 0 };
        const { width, height } = mine;
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
                if (d > this.params.deghostThreshold) stats.inconsistentPixels += step * step;
            }
        }
        return { stats, overlap, difference, present };
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
