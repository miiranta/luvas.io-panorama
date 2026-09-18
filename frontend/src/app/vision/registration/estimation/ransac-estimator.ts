import { ModelParams } from '../../../core/models/params';
import { Mat3, mat3Inverse } from '../../foundation/math/matrix3';
import { Correspondence, MIN_PAIRS } from './correspondence';
import { fitModel, isPlausibleHomography } from './fit-model';
import { symmetricTransferError } from './transfer-error';

const SAMPLE_COVERAGE = 3;

function distinctSamples(count: number, size: number): number {
    let total = 1;
    for (let i = 0; i < size; i++) {
        total = (total * (count - i)) / (i + 1);
        if (total > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
    }
    return Math.max(1, Math.round(total));
}

export interface ModelFit {
    matrix: Mat3;
    inliers: Uint8Array;
    inlierCount: number;
    meanError: number;
}

export class RansacEstimator {
    constructor(
        private readonly params: ModelParams,
        private readonly random: () => number = Math.random,
    ) {}

    fit(points: readonly Correspondence[]): ModelFit | null {
        const params = this.params;
        const kind = params.model;
        const sampleSize = MIN_PAIRS[kind];
        if (points.length < sampleSize) return null;
        const threshold = params.ransacThreshold;
        let bestInliers: Uint8Array | null = null;
        let bestCount = 0;
        let bestError = Number.POSITIVE_INFINITY;
        let bestMatrix: Mat3 | null = null;
        let maxIterations = Math.min(
            params.ransacMaxIterations,
            distinctSamples(points.length, sampleSize) * SAMPLE_COVERAGE,
        );
        const indices = new Array<number>(sampleSize);
        let iteration = 0;
        while (iteration < maxIterations) {
            iteration++;
            for (let s = 0; s < sampleSize; s++) {
                let candidate = 0;
                let unique = false;
                while (!unique) {
                    candidate = Math.floor(this.random() * points.length);
                    unique = true;
                    for (let t = 0; t < s; t++) if (indices[t] === candidate) unique = false;
                }
                indices[s] = candidate;
            }
            const model = fitModel(kind, points, indices);
            if (!model || !isPlausibleHomography(model, kind, params.rejectSkew)) continue;
            let count = 0;
            let error = 0;
            const modelInverse = mat3Inverse(model);
            const inliers = new Uint8Array(points.length);
            for (let i = 0; i < points.length; i++) {
                const e = symmetricTransferError(model, modelInverse, points[i]);
                if (e <= threshold) {
                    inliers[i] = 1;
                    count++;
                    error += e;
                }
            }
            if (
                count > bestCount ||
                (count === bestCount && error / Math.max(1, count) < bestError)
            ) {
                bestCount = count;
                bestInliers = inliers;
                bestMatrix = model;
                bestError = error / Math.max(1, count);
                const w = count / points.length;
                if (w > 0 && w < 1) {
                    const denom = Math.log(1 - Math.pow(w, sampleSize));
                    if (denom < -1e-12) {
                        const needed = Math.ceil(Math.log(1 - params.ransacConfidence) / denom);
                        maxIterations = Math.min(maxIterations, Math.max(needed, sampleSize * 4));
                    }
                } else if (w >= 1) {
                    maxIterations = Math.min(maxIterations, iteration);
                }
            }
        }
        if (!bestMatrix || !bestInliers) return null;
        let matrix = bestMatrix;
        let inliers = bestInliers;
        let count = bestCount;
        if (params.refitOnInliers && count >= sampleSize) {
            const inlierIndices: number[] = [];
            for (let i = 0; i < inliers.length; i++) if (inliers[i]) inlierIndices.push(i);
            const refined = fitModel(kind, points, inlierIndices);
            if (refined && isPlausibleHomography(refined, kind, params.rejectSkew)) {
                const refinedInverse = mat3Inverse(refined);
                const nextInliers = new Uint8Array(points.length);
                let nextCount = 0;
                for (let i = 0; i < points.length; i++) {
                    if (symmetricTransferError(refined, refinedInverse, points[i]) <= threshold) {
                        nextInliers[i] = 1;
                        nextCount++;
                    }
                }
                if (nextCount >= count) {
                    matrix = refined;
                    inliers = nextInliers;
                    count = nextCount;
                }
            }
        }
        let errorSum = 0;
        const finalInverse = mat3Inverse(matrix);
        for (let i = 0; i < points.length; i++)
            if (inliers[i]) errorSum += symmetricTransferError(matrix, finalInverse, points[i]);
        return {
            matrix,
            inliers,
            inlierCount: count,
            meanError: count === 0 ? Number.POSITIVE_INFINITY : errorSum / count,
        };
    }
}
