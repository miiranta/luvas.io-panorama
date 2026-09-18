export interface OverlapIntensity {
    a: number;
    b: number;
    meanA: number;
    meanB: number;
    weight: number;
}

export class ExposureCompensator {
    constructor(private readonly sigmaGain = 0.12) {}

    solve(pairs: readonly OverlapIntensity[], cameraCount: number): Float64Array {
        const gains = new Float64Array(cameraCount).fill(1);
        if (pairs.length === 0) return gains;
        const prior = 1 / (this.sigmaGain * this.sigmaGain);
        for (let iteration = 0; iteration < 48; iteration++) {
            let maxDelta = 0;
            for (let i = 0; i < cameraCount; i++) {
                let numerator = prior;
                let denominator = prior;
                for (const pair of pairs) {
                    if (pair.a === i) {
                        numerator += pair.weight * gains[pair.b] * pair.meanB * pair.meanA;
                        denominator += pair.weight * pair.meanA * pair.meanA;
                    } else if (pair.b === i) {
                        numerator += pair.weight * gains[pair.a] * pair.meanA * pair.meanB;
                        denominator += pair.weight * pair.meanB * pair.meanB;
                    }
                }
                if (denominator < 1e-9) continue;
                const next = Math.min(3, Math.max(0.33, numerator / denominator));
                maxDelta = Math.max(maxDelta, Math.abs(next - gains[i]));
                gains[i] = next;
            }
            if (maxDelta < 1e-5) break;
        }
        let mean = 0;
        for (let i = 0; i < cameraCount; i++) mean += gains[i];
        mean /= cameraCount;
        if (mean > 1e-6) for (let i = 0; i < cameraCount; i++) gains[i] /= mean;
        return gains;
    }
}
