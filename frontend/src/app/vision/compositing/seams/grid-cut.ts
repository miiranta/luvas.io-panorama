const RIGHT = 0;
const DOWN = 2;
const TERMINAL = 4;
const ORPHAN = -1;
const FREE = 0;
const SOURCE = 1;
const SINK = 2;
const INFINITE_DISTANCE = 1 << 30;

export const HARD_TERMINAL = 1e12;

export class GridCut {
    private readonly cells: number;
    private readonly capacity: Float32Array;
    private readonly terminal: Float64Array;
    private readonly tree: Uint8Array;
    private readonly parent: Int8Array;
    private readonly stamp: Int32Array;
    private readonly distance: Int32Array;
    private readonly active: Int32Array;
    private readonly queued: Uint8Array;
    private readonly orphans: Int32Array;
    private activeHead = 0;
    private activeCount = 0;
    private orphanHead = 0;
    private orphanCount = 0;
    private time = 0;

    constructor(
        readonly width: number,
        readonly height: number,
        private readonly enabled: Uint8Array,
    ) {
        this.cells = width * height;
        this.capacity = new Float32Array(this.cells * 4);
        this.terminal = new Float64Array(this.cells);
        this.tree = new Uint8Array(this.cells);
        this.parent = new Int8Array(this.cells).fill(ORPHAN);
        this.stamp = new Int32Array(this.cells);
        this.distance = new Int32Array(this.cells);
        this.active = new Int32Array(this.cells);
        this.queued = new Uint8Array(this.cells);
        this.orphans = new Int32Array(this.cells);
    }

    link(cell: number, horizontal: boolean, weight: number): void {
        const direction = horizontal ? RIGHT : DOWN;
        const other = this.neighbor(cell, direction);
        if (other < 0) return;
        this.capacity[cell * 4 + direction] = weight;
        this.capacity[other * 4 + (direction ^ 1)] = weight;
    }

    setTerminal(cell: number, sourceMinusSink: number): void {
        this.terminal[cell] = sourceMinusSink;
    }

    solve(): Int8Array {
        this.initialize();
        let current = -1;
        for (;;) {
            let cell = current >= 0 && this.tree[current] !== FREE ? current : -1;
            if (cell < 0) cell = this.nextActive();
            if (cell < 0) break;
            const bridge = this.grow(cell);
            this.time++;
            if (bridge < 0) {
                current = -1;
                continue;
            }
            current = cell;
            this.augment(bridge);
            while (this.orphanCount > 0) this.adopt(this.popOrphan());
        }
        const labels = new Int8Array(this.cells).fill(-1);
        for (let cell = 0; cell < this.cells; cell++) {
            if (this.tree[cell] === SOURCE) labels[cell] = 0;
            else if (this.tree[cell] === SINK) labels[cell] = 1;
        }
        return labels;
    }

    private neighbor(cell: number, direction: number): number {
        const width = this.width;
        let other = -1;
        if (direction === 0) other = cell % width < width - 1 ? cell + 1 : -1;
        else if (direction === 1) other = cell % width > 0 ? cell - 1 : -1;
        else if (direction === 2) other = cell + width < this.cells ? cell + width : -1;
        else other = cell >= width ? cell - width : -1;
        return other >= 0 && this.enabled[other] ? other : -1;
    }

    private initialize(): void {
        for (let cell = 0; cell < this.cells; cell++) {
            if (!this.enabled[cell] || this.terminal[cell] === 0) continue;
            this.tree[cell] = this.terminal[cell] > 0 ? SOURCE : SINK;
            this.parent[cell] = TERMINAL;
            this.distance[cell] = 1;
            this.enqueue(cell);
        }
    }

    private enqueue(cell: number): void {
        if (this.queued[cell]) return;
        this.queued[cell] = 1;
        this.active[(this.activeHead + this.activeCount) % this.cells] = cell;
        this.activeCount++;
    }

    private nextActive(): number {
        while (this.activeCount > 0) {
            const cell = this.active[this.activeHead];
            this.activeHead = (this.activeHead + 1) % this.cells;
            this.activeCount--;
            this.queued[cell] = 0;
            if (this.tree[cell] !== FREE) return cell;
        }
        return -1;
    }

    private orphan(cell: number): void {
        this.parent[cell] = ORPHAN;
        this.orphans[(this.orphanHead + this.orphanCount) % this.cells] = cell;
        this.orphanCount++;
    }

    private popOrphan(): number {
        const cell = this.orphans[this.orphanHead];
        this.orphanHead = (this.orphanHead + 1) % this.cells;
        this.orphanCount--;
        return cell;
    }

    private residualToward(from: number, direction: number, other: number): number {
        return this.tree[from] === SOURCE
            ? this.capacity[from * 4 + direction]
            : this.capacity[other * 4 + (direction ^ 1)];
    }

    private grow(cell: number): number {
        const side = this.tree[cell];
        for (let direction = 0; direction < 4; direction++) {
            const other = this.neighbor(cell, direction);
            if (other < 0 || this.residualToward(cell, direction, other) <= 0) continue;
            const tree = this.tree[other];
            if (tree === FREE) {
                this.tree[other] = side;
                this.parent[other] = direction ^ 1;
                this.stamp[other] = this.stamp[cell];
                this.distance[other] = this.distance[cell] + 1;
                this.enqueue(other);
            } else if (tree !== side) {
                return side === SOURCE ? cell * 4 + direction : other * 4 + (direction ^ 1);
            } else if (
                this.stamp[other] <= this.stamp[cell] &&
                this.distance[other] > this.distance[cell]
            ) {
                this.parent[other] = direction ^ 1;
                this.stamp[other] = this.stamp[cell];
                this.distance[other] = this.distance[cell] + 1;
            }
        }
        return -1;
    }

    private augment(bridge: number): void {
        const source = bridge >> 2;
        const direction = bridge & 3;
        const sink = this.neighbor(source, direction);
        let flow = this.capacity[bridge];
        for (let cell = source; ;) {
            const up = this.parent[cell];
            if (up === TERMINAL) {
                flow = Math.min(flow, this.terminal[cell]);
                break;
            }
            const next = this.neighbor(cell, up);
            flow = Math.min(flow, this.capacity[next * 4 + (up ^ 1)]);
            cell = next;
        }
        for (let cell = sink; ;) {
            const up = this.parent[cell];
            if (up === TERMINAL) {
                flow = Math.min(flow, -this.terminal[cell]);
                break;
            }
            flow = Math.min(flow, this.capacity[cell * 4 + up]);
            cell = this.neighbor(cell, up);
        }
        this.capacity[bridge] -= flow;
        this.capacity[sink * 4 + (direction ^ 1)] += flow;
        for (let cell = source; ;) {
            const up = this.parent[cell];
            if (up === TERMINAL) {
                this.terminal[cell] -= flow;
                if (this.terminal[cell] <= 0) this.orphan(cell);
                break;
            }
            const next = this.neighbor(cell, up);
            const forward = next * 4 + (up ^ 1);
            this.capacity[cell * 4 + up] += flow;
            this.capacity[forward] -= flow;
            if (this.capacity[forward] <= 0) this.orphan(cell);
            cell = next;
        }
        for (let cell = sink; ;) {
            const up = this.parent[cell];
            if (up === TERMINAL) {
                this.terminal[cell] += flow;
                if (this.terminal[cell] >= 0) this.orphan(cell);
                break;
            }
            const next = this.neighbor(cell, up);
            const forward = cell * 4 + up;
            this.capacity[forward] -= flow;
            this.capacity[next * 4 + (up ^ 1)] += flow;
            if (this.capacity[forward] <= 0) this.orphan(cell);
            cell = next;
        }
    }

    private originLength(start: number): number {
        let length = 0;
        for (let cell = start; ;) {
            if (this.stamp[cell] === this.time) return length + this.distance[cell];
            const up = this.parent[cell];
            length++;
            if (up === TERMINAL) {
                this.stamp[cell] = this.time;
                this.distance[cell] = 1;
                return length;
            }
            if (up === ORPHAN) return INFINITE_DISTANCE;
            cell = this.neighbor(cell, up);
        }
    }

    private adopt(cell: number): void {
        const side = this.tree[cell];
        let best = -1;
        let bestLength = INFINITE_DISTANCE;
        for (let direction = 0; direction < 4; direction++) {
            const other = this.neighbor(cell, direction);
            if (other < 0 || this.tree[other] !== side) continue;
            if (this.residualToward(other, direction ^ 1, cell) <= 0) continue;
            const length = this.originLength(other);
            if (length >= INFINITE_DISTANCE) continue;
            if (length < bestLength) {
                best = direction;
                bestLength = length;
            }
            for (let node = other, remaining = length; this.stamp[node] !== this.time;) {
                this.stamp[node] = this.time;
                this.distance[node] = remaining--;
                node = this.neighbor(node, this.parent[node]);
            }
        }
        if (best >= 0) {
            this.parent[cell] = best;
            this.stamp[cell] = this.time;
            this.distance[cell] = bestLength + 1;
            return;
        }
        this.stamp[cell] = 0;
        for (let direction = 0; direction < 4; direction++) {
            const other = this.neighbor(cell, direction);
            if (other < 0 || this.tree[other] !== side) continue;
            if (this.residualToward(other, direction ^ 1, cell) > 0) this.enqueue(other);
            const up = this.parent[other];
            if (up >= 0 && up !== TERMINAL && this.neighbor(other, up) === cell) this.orphan(other);
        }
        this.tree[cell] = FREE;
        this.parent[cell] = ORPHAN;
    }
}
