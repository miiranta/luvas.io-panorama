export interface OverlapIntensity {
    a: number;
    b: number;
    meanA: number;
    meanB: number;
    weight: number;
}

const SIGMA_INTENSITY = 10;
const SIGMA_GAIN = 0.1;
const MIN_GAIN = 0.33;
const MAX_GAIN = 3;
const ITERATIONS = 64;

const INTENSITY_SCALE = 2 / (SIGMA_INTENSITY * SIGMA_INTENSITY);
const GAIN_SCALE = 1 / (SIGMA_GAIN * SIGMA_GAIN);

function optimalGain(
    camera: number,
    pairs: readonly OverlapIntensity[],
    gains: Float64Array,
): number | null {
    let numerator = 0;
    let denominator = 0;
    for (const pair of pairs) {
        const first = pair.a === camera;
        const mine = first ? pair.meanA : pair.meanB;
        const other = first ? pair.meanB : pair.meanA;
        const gain = gains[first ? pair.b : pair.a];
        numerator += pair.weight * (gain * other * mine * INTENSITY_SCALE + GAIN_SCALE);
        denominator += pair.weight * (mine * mine * INTENSITY_SCALE + GAIN_SCALE);
    }
    if (denominator < 1e-9) return null;
    return Math.min(MAX_GAIN, Math.max(MIN_GAIN, numerator / denominator));
}

export class ExposureCompensator {
    solve(pairs: readonly OverlapIntensity[], cameraCount: number): Float64Array {
        const gains = new Float64Array(cameraCount).fill(1);
        if (pairs.length === 0) return gains;
        const touching: OverlapIntensity[][] = Array.from({ length: cameraCount }, () => []);
        for (const pair of pairs) {
            touching[pair.a]?.push(pair);
            if (pair.b !== pair.a) touching[pair.b]?.push(pair);
        }
        for (let iteration = 0; iteration < ITERATIONS; iteration++) {
            let maxDelta = 0;
            for (let i = 0; i < cameraCount; i++) {
                const next = optimalGain(i, touching[i], gains);
                if (next === null) continue;
                maxDelta = Math.max(maxDelta, Math.abs(next - gains[i]));
                gains[i] = next;
            }
            if (maxDelta < 1e-6) break;
        }
        let mean = 0;
        for (let i = 0; i < cameraCount; i++) mean += gains[i];
        mean /= cameraCount;
        if (mean > 1e-6) for (let i = 0; i < cameraCount; i++) gains[i] /= mean;
        return gains;
    }
}
