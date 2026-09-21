import { GridCut, HARD_TERMINAL } from './grid-cut';

function random(seed: number): () => number {
    let state = seed;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
    };
}

interface Problem {
    width: number;
    height: number;
    seeds: Int8Array;
    right: Float32Array;
    down: Float32Array;
}

function randomProblem(seed: number, width: number, height: number): Problem {
    const next = random(seed);
    const cells = width * height;
    const seeds = new Int8Array(cells).fill(-1);
    for (let y = 0; y < height; y++) {
        seeds[y * width] = 0;
        seeds[y * width + width - 1] = 1;
    }
    const right = new Float32Array(cells);
    const down = new Float32Array(cells);
    for (let cell = 0; cell < cells; cell++) {
        right[cell] = Math.round(next() * 20) + 1;
        down[cell] = Math.round(next() * 20) + 1;
    }
    return { width, height, seeds, right, down };
}

function cutCost(problem: Problem, labels: ArrayLike<number>): number {
    const { width, height, right, down } = problem;
    const side = (cell: number) => (labels[cell] === 0 ? 0 : 1);
    let cost = 0;
    for (let cell = 0; cell < width * height; cell++) {
        if (cell % width < width - 1 && side(cell) !== side(cell + 1)) cost += right[cell];
        if (cell + width < width * height && side(cell) !== side(cell + width)) cost += down[cell];
    }
    return cost;
}

function bruteForce(problem: Problem): number {
    const free = [...problem.seeds.keys()].filter((cell) => problem.seeds[cell] < 0);
    const labels = Int8Array.from(problem.seeds);
    let best = Number.POSITIVE_INFINITY;
    for (let mask = 0; mask < 1 << free.length; mask++) {
        free.forEach((cell, bit) => (labels[cell] = (mask >> bit) & 1));
        best = Math.min(best, cutCost(problem, labels));
    }
    return best;
}

function solve(problem: Problem): Int8Array {
    const { width, height, seeds, right, down } = problem;
    const cut = new GridCut(width, height, new Uint8Array(width * height).fill(1));
    for (let cell = 0; cell < width * height; cell++) {
        if (seeds[cell] >= 0)
            cut.setTerminal(cell, seeds[cell] === 0 ? HARD_TERMINAL : -HARD_TERMINAL);
        cut.link(cell, true, right[cell]);
        cut.link(cell, false, down[cell]);
    }
    return cut.solve();
}

describe('GridCut', () => {
    it('finds the minimum cut of random grids (checked by brute force)', () => {
        for (let seed = 1; seed <= 40; seed++) {
            const problem = randomProblem(seed, 5 + (seed % 2), 3);
            const labels = solve(problem);
            problem.seeds.forEach((label, cell) => {
                if (label >= 0) expect(labels[cell]).toBe(label);
            });
            expect(cutCost(problem, labels)).toBe(bruteForce(problem));
        }
    });

    it('routes the cut around an expensive blob instead of through it', () => {
        const width = 30;
        const height = 20;
        const cells = width * height;
        const cost = new Float32Array(cells);
        for (let y = 6; y < 14; y++) for (let x = 12; x < 18; x++) cost[y * width + x] = 200;
        const cut = new GridCut(width, height, new Uint8Array(cells).fill(1));
        for (let cell = 0; cell < cells; cell++) {
            const x = cell % width;
            if (x === 0) cut.setTerminal(cell, HARD_TERMINAL);
            if (x === width - 1) cut.setTerminal(cell, -HARD_TERMINAL);
            if (x + 1 < width) cut.link(cell, true, cost[cell] + cost[cell + 1] + 1);
            if (cell + width < cells) cut.link(cell, false, cost[cell] + cost[cell + width] + 1);
        }
        const labels = cut.solve();
        const blob = new Set<number>();
        for (let y = 6; y < 14; y++) for (let x = 12; x < 18; x++) blob.add(labels[y * width + x]);
        expect(blob.size).toBe(1);
    });

    it('leaves disabled cells out of both sides', () => {
        const enabled = new Uint8Array([1, 1, 0, 1, 1]);
        const cut = new GridCut(5, 1, enabled);
        cut.setTerminal(0, HARD_TERMINAL);
        cut.setTerminal(4, -HARD_TERMINAL);
        for (let cell = 0; cell < 4; cell++) cut.link(cell, true, 1);
        expect(Array.from(cut.solve())).toEqual([0, 0, -1, 1, 1]);
    });
});
