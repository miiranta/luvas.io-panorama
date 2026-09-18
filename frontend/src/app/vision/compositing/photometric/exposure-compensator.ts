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

export class ExposureCompensator {
    solve(pairs: readonly OverlapIntensity[], cameraCount: number): Float64Array {
        const gains = new Float64Array(cameraCount).fill(1);
        if (pairs.length === 0) return gains;
        const intensityScale = 1 / (SIGMA_INTENSITY * SIGMA_INTENSITY);
        const gainScale = 1 / (SIGMA_GAIN * SIGMA_GAIN);
        for (let iteration = 0; iteration < ITERATIONS; iteration++) {
            let maxDelta = 0;
            for (let i = 0; i < cameraCount; i++) {
                let numerator = 0;
                let denominator = 0;
                for (const pair of pairs) {
                    const mine = pair.a === i ? pair.meanA : pair.b === i ? pair.meanB : null;
                    if (mine === null) continue;
                    const other = pair.a === i ? pair.meanB : pair.meanA;
                    const gain = gains[pair.a === i ? pair.b : pair.a];
                    numerator += pair.weight * (gain * other * mine * intensityScale + gainScale);
                    denominator += pair.weight * (mine * mine * intensityScale + gainScale);
                }
                if (denominator < 1e-9) continue;
                const next = Math.min(MAX_GAIN, Math.max(MIN_GAIN, numerator / denominator));
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
