import { ComposeParams } from '../../../core/models/params';
import { MosaicSurface, TileSnapshot, cellSource } from '../blending/mosaic-surface';
import { WarpTile } from '../warping/warp-tile';
import { GridCut, HARD_TERMINAL } from './grid-cut';

const LENGTH_COST = 1;
const CENTER_COST = 4;
const DEGHOST_PENALTY = 512;

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

function dilate(values: Float32Array, width: number, height: number, radius: number): Float32Array {
    const across = new Float32Array(values.length);
    for (let y = 0; y < height; y++) {
        const row = y * width;
        for (let x = 0; x < width; x++) {
            let peak = 0;
            const last = Math.min(width - 1, x + radius);
            for (let i = Math.max(0, x - radius); i <= last; i++)
                peak = Math.max(peak, values[row + i]);
            across[row + x] = peak;
        }
    }
    const dilated = new Float32Array(values.length);
    for (let y = 0; y < height; y++) {
        const last = Math.min(height - 1, y + radius);
        for (let x = 0; x < width; x++) {
            let peak = 0;
            for (let j = Math.max(0, y - radius); j <= last; j++) {
                peak = Math.max(peak, across[j * width + x]);
            }
            dilated[y * width + x] = peak;
        }
    }
    return dilated;
}

function seamCost(
    difference: Float32Array,
    width: number,
    height: number,
    radius: number,
    params: ComposeParams,
): Float32Array {
    const cost = dilate(difference, width, height, radius);
    if (!params.deghost) return cost;
    for (let cell = 0; cell < cost.length; cell++) {
        if (cost[cell] > params.deghostThreshold) cost[cell] += DEGHOST_PENALTY;
    }
    return cost;
}

function seedDistance(
    side: Int8Array,
    wanted: number,
    enabled: Uint8Array,
    width: number,
    cells: number,
): Float64Array {
    const distance = new Float64Array(cells).fill(Number.POSITIVE_INFINITY);
    const queue = new Int32Array(cells);
    let head = 0;
    let tail = 0;
    for (let cell = 0; cell < cells; cell++) {
        if (side[cell] !== wanted) continue;
        distance[cell] = 0;
        queue[tail++] = cell;
    }
    while (head < tail) {
        const current = queue[head++];
        const next = distance[current] + 1;
        forEachNeighbor(current, width, cells, (neighbor) => {
            if (!enabled[neighbor] || distance[neighbor] <= next) return;
            distance[neighbor] = next;
            queue[tail++] = neighbor;
        });
    }
    return distance;
}

function offCenter(toOld: Float64Array, toNew: Float64Array): Float32Array {
    const away = new Float32Array(toOld.length);
    for (let cell = 0; cell < away.length; cell++) {
        const a = toOld[cell];
        const b = toNew[cell];
        away[cell] =
            Number.isFinite(a) && Number.isFinite(b) ? Math.abs(a - b) / Math.max(1, a + b) : 1;
    }
    return away;
}

function cutLabels(
    mine: TileSnapshot,
    other: TileSnapshot | null,
    overlap: Uint8Array,
    present: Uint8Array,
    cost: Float32Array,
): Int8Array {
    const { width, height } = mine;
    const cells = width * height;
    const enabled = new Uint8Array(cells);
    for (let cell = 0; cell < cells; cell++) {
        enabled[cell] =
            overlap[cell] || present[cell] || mine.covered[cell] || other?.covered[cell] ? 1 : 0;
    }
    const side = new Int8Array(cells).fill(-1);
    for (let cell = 0; cell < cells; cell++) {
        if (enabled[cell] && !overlap[cell]) side[cell] = present[cell] ? 1 : 0;
    }
    const away = offCenter(
        seedDistance(side, 0, enabled, width, cells),
        seedDistance(side, 1, enabled, width, cells),
    );
    const weight = (a: number, b: number) =>
        cost[a] + cost[b] + LENGTH_COST + CENTER_COST * (away[a] + away[b]);
    const cut = new GridCut(width, height, enabled);
    for (let cell = 0; cell < cells; cell++) {
        if (!enabled[cell]) continue;
        if (side[cell] >= 0) cut.setTerminal(cell, side[cell] ? -HARD_TERMINAL : HARD_TERMINAL);
        if (cell % width < width - 1 && enabled[cell + 1]) {
            cut.link(cell, true, weight(cell, cell + 1));
        }
        if (cell + width < cells && enabled[cell + width]) {
            cut.link(cell, false, weight(cell, cell + width));
        }
    }
    return cut.solve();
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
        const ramp = Math.max(1, params.featherWidth / 6 / step);
        const cost = seamCost(difference, width, height, Math.round(ramp), params);
        const label = cutLabels(mine, other, overlap, present, cost);
        const distance = seamDistance(label, overlap, width, width * height);
        this.applyCells(tile, step, width, height, (cell, current) => {
            if (!overlap[cell]) return -1;
            if (label[cell] === 0) return 0;
            if (label[cell] === 1) {
                return ghost(cell) === 0 ? -1 : Math.min(current, distance[cell] / ramp);
            }
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
