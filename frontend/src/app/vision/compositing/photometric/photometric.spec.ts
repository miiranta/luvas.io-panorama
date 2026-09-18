import { ExposureCompensator } from './exposure-compensator';
import { VignettingSample, estimateVignetting, vignetteAt } from './vignetting';

describe('photometric calibration', () => {
    it('corrects most of the exposure difference while keeping the gain prior', () => {
        const brightness = [1, 1.3, 0.8];
        const pairs = [
            { a: 0, b: 1, meanA: 100 * brightness[0], meanB: 100 * brightness[1], weight: 1000 },
            { a: 1, b: 2, meanA: 90 * brightness[1], meanB: 90 * brightness[2], weight: 1000 },
        ];
        const gains = new ExposureCompensator().solve(pairs, 3);
        for (const [a, b] of [
            [0, 1],
            [1, 2],
        ]) {
            const before = Math.abs(brightness[a] / brightness[b] - 1);
            const after = Math.abs((gains[a] * brightness[a]) / (gains[b] * brightness[b]) - 1);
            expect(after).toBeLessThan(before / 4);
        }
        expect((gains[0] + gains[1] + gains[2]) / 3).toBeCloseTo(1, 12);
    });

    it('minimizes the Brown–Lowe gain objective over ordered pairs', () => {
        const pairs = [
            { a: 0, b: 1, meanA: 120, meanB: 150, weight: 800 },
            { a: 1, b: 2, meanA: 95, meanB: 70, weight: 1200 },
            { a: 0, b: 2, meanA: 60, meanB: 52, weight: 300 },
        ];
        const objective = (g: number[]) => {
            let e = 0;
            for (const p of pairs) {
                for (const [i, j, mi, mj] of [
                    [p.a, p.b, p.meanA, p.meanB],
                    [p.b, p.a, p.meanB, p.meanA],
                ]) {
                    e +=
                        0.5 *
                        p.weight *
                        ((g[i] * mi - g[j] * mj) ** 2 / 100 + (1 - g[i]) ** 2 / 0.01);
                }
            }
            return e;
        };
        const direction = Array.from(new ExposureCompensator().solve(pairs, 3));
        let low = 0.5;
        let high = 2;
        for (let i = 0; i < 200; i++) {
            const a = low + (high - low) / 3;
            const b = high - (high - low) / 3;
            if (objective(direction.map((g) => g * a)) < objective(direction.map((g) => g * b)))
                high = b;
            else low = a;
        }
        const solution = direction.map((g) => (g * (low + high)) / 2);
        for (let i = 0; i < 3; i++) {
            const step = 1e-6;
            const up = solution.slice();
            const down = solution.slice();
            up[i] += step;
            down[i] -= step;
            expect(Math.abs((objective(up) - objective(down)) / (2 * step))).toBeLessThan(0.5);
        }
    });

    it('keeps unit gains without overlaps', () => {
        expect(Array.from(new ExposureCompensator().solve([], 2))).toEqual([1, 1]);
    });

    it('estimates the vignetting falloff from matched intensities', () => {
        const beta = -0.3;
        const samples: VignettingSample[] = [];
        for (let i = 0; i < 200; i++) {
            const radiusSquaredA = ((i * 13) % 50) / 100;
            const radiusSquaredB = ((i * 29) % 50) / 100;
            const scene = 60 + ((i * 7) % 120);
            samples.push({
                a: i % 2,
                b: 1 - (i % 2),
                radiusSquaredA,
                radiusSquaredB,
                intensityA: scene * vignetteAt(radiusSquaredA, beta),
                intensityB: scene * vignetteAt(radiusSquaredB, beta),
            });
        }
        expect(estimateVignetting(samples, 2)).toBeCloseTo(beta, 2);
    });

    it('does not guess vignetting from too few samples', () => {
        expect(estimateVignetting([], 3)).toBe(0);
    });
});
