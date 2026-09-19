import { solveLinearSystem } from '../../foundation/math/gaussian-elimination';

const MIN_SAMPLES = 40;
const ITERATIONS = 6;
const GAIN_PRIOR = 0.5;
const BETA_PRIOR = 0.5;
const HUBER = 0.15;
const LOG_NOISE = 0.08;
const DARK_LIMIT = 8;
const BRIGHT_LIMIT = 245;
const MIN_BETA = -0.8;
const MAX_BETA = 0.5;

export interface VignettingSample {
    a: number;
    b: number;
    radiusSquaredA: number;
    radiusSquaredB: number;
    intensityA: number;
    intensityB: number;
}

export function vignetteAt(radiusSquared: number, beta: number): number {
    return Math.max(0.05, 1 + beta * radiusSquared);
}

export function estimateVignetting(samples: readonly VignettingSample[], cameras: number): number {
    const usable = samples.filter(
        (sample) =>
            sample.intensityA > DARK_LIMIT &&
            sample.intensityB > DARK_LIMIT &&
            sample.intensityA < BRIGHT_LIMIT &&
            sample.intensityB < BRIGHT_LIMIT &&
            Math.abs(sample.radiusSquaredA - sample.radiusSquaredB) > 1e-3,
    );
    if (usable.length < MIN_SAMPLES || cameras < 2) return 0;
    const observed = usable.map(
        (sample) => Math.log(sample.intensityA) - Math.log(sample.intensityB),
    );
    const count = cameras + 1;
    const betaIndex = cameras;
    const state = new Float64Array(count);
    for (let iteration = 0; iteration < ITERATIONS; iteration++) {
        const normal = new Float64Array(count * count);
        const gradient = new Float64Array(count);
        const beta = state[betaIndex];
        usable.forEach((sample, index) => {
            const va = vignetteAt(sample.radiusSquaredA, beta);
            const vb = vignetteAt(sample.radiusSquaredB, beta);
            const residual =
                observed[index] -
                (state[sample.a] - state[sample.b]) -
                (Math.log(va) - Math.log(vb));
            const weight =
                (Math.abs(residual) <= HUBER ? 1 : HUBER / Math.abs(residual)) /
                (LOG_NOISE * LOG_NOISE);
            const jBeta = -(sample.radiusSquaredA / va - sample.radiusSquaredB / vb);
            const entries: [number, number][] = [
                [sample.a, -1],
                [sample.b, 1],
                [betaIndex, jBeta],
            ];
            for (const [row, jr] of entries) {
                gradient[row] -= weight * jr * residual;
                for (const [column, jc] of entries) {
                    normal[row * count + column] += weight * jr * jc;
                }
            }
        });
        for (let i = 0; i < cameras; i++) {
            normal[i * count + i] += 1 / (GAIN_PRIOR * GAIN_PRIOR);
            gradient[i] -= state[i] / (GAIN_PRIOR * GAIN_PRIOR);
        }
        normal[betaIndex * count + betaIndex] += 1 / (BETA_PRIOR * BETA_PRIOR);
        gradient[betaIndex] -= beta / (BETA_PRIOR * BETA_PRIOR);
        const delta = solveLinearSystem(normal, gradient, count);
        if (!delta) return 0;
        for (let i = 0; i < count; i++) state[i] += delta[i];
        state[betaIndex] = Math.min(MAX_BETA, Math.max(MIN_BETA, state[betaIndex]));
        if (Math.abs(delta[betaIndex]) < 1e-5) break;
    }
    return state[betaIndex];
}
