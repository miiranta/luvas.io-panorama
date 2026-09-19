import { ModelParams } from '../../../core/models/params';
import { Mat3, mat3Inverse } from '../../foundation/math/matrix3';
import { Correspondence, MIN_PAIRS, localizationScale } from './correspondence';
import { fitModel, isPlausibleModel } from './fit-model';
import { symmetricTransferError } from './transfer-error';

const SAMPLE_COVERAGE = 3;
const REFINE_ROUNDS = 10;
const SHRINK_ROUNDS = 4;
const WIDENED_THRESHOLD = 2;
const MIN_RETAINED = 0.5;

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

interface Selection {
    inliers: Uint8Array;
    count: number;
    error: number;
}

interface Hypothesis extends Selection {
    matrix: Mat3;
}

function meanOf(selection: Selection): number {
    return selection.error / Math.max(1, selection.count);
}

function beats(candidate: Selection, best: Selection | null): boolean {
    if (!best) return true;
    if (candidate.count !== best.count) return candidate.count > best.count;
    return meanOf(candidate) < meanOf(best);
}

function adaptiveLimit(
    inlierRatio: number,
    sampleSize: number,
    confidence: number,
    current: number,
    iteration: number,
): number {
    if (inlierRatio >= 1) return Math.min(current, iteration);
    if (inlierRatio <= 0) return current;
    const denom = Math.log(1 - Math.pow(inlierRatio, sampleSize));
    if (denom >= -1e-12) return current;
    const needed = Math.ceil(Math.log(1 - confidence) / denom);
    return Math.min(current, Math.max(needed, sampleSize * 4));
}

function alreadyDrawn(indices: readonly number[], count: number, candidate: number): boolean {
    for (let t = 0; t < count; t++) if (indices[t] === candidate) return true;
    return false;
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
        const limits = points.map((point) => params.ransacThreshold * localizationScale(point));
        let best: Hypothesis | null = null;
        let maxIterations = Math.min(
            params.ransacMaxIterations,
            distinctSamples(points.length, sampleSize) * SAMPLE_COVERAGE,
        );
        const indices = new Array<number>(sampleSize);
        let iteration = 0;
        while (iteration < maxIterations) {
            iteration++;
            this.drawSample(indices, points.length);
            const model = fitModel(kind, points, indices);
            if (!model || !isPlausibleModel(model, kind, params.rejectSkew)) continue;
            const selection = select(model, points, limits, 1);
            if (!beats(selection, best)) continue;
            best = { matrix: model, ...selection };
            maxIterations = adaptiveLimit(
                selection.count / points.length,
                sampleSize,
                params.ransacConfidence,
                maxIterations,
                iteration,
            );
        }
        if (!best) return null;
        const final = this.polish(best, points, limits, sampleSize);
        return {
            matrix: final.matrix,
            inliers: final.inliers,
            inlierCount: final.count,
            meanError: final.count === 0 ? Number.POSITIVE_INFINITY : final.error / final.count,
        };
    }

    private drawSample(indices: number[], total: number): void {
        for (let s = 0; s < indices.length; s++) {
            let candidate = Math.floor(this.random() * total);
            while (alreadyDrawn(indices, s, candidate)) {
                candidate = Math.floor(this.random() * total);
            }
            indices[s] = candidate;
        }
    }

    private polish(
        best: Hypothesis,
        points: readonly Correspondence[],
        limits: readonly number[],
        sampleSize: number,
    ): Hypothesis {
        if (!this.params.refitOnInliers || best.count < sampleSize) return best;
        const refined = this.refine(best.matrix, points, limits, sampleSize);
        const retained = Math.max(sampleSize, best.count * MIN_RETAINED);
        return refined && refined.count >= retained ? refined : best;
    }

    private refine(
        start: Mat3,
        points: readonly Correspondence[],
        limits: readonly number[],
        sampleSize: number,
    ): Hypothesis | null {
        const { model: kind, rejectSkew } = this.params;
        let matrix = start;
        let current = select(matrix, points, limits, WIDENED_THRESHOLD);
        for (let round = 0; round < REFINE_ROUNDS; round++) {
            if (current.count < sampleSize) return null;
            const indices: number[] = [];
            for (let i = 0; i < current.inliers.length; i++)
                if (current.inliers[i]) indices.push(i);
            const refined = fitModel(kind, points, indices);
            if (!refined || !isPlausibleModel(refined, kind, rejectSkew)) break;
            const factor = Math.max(
                1,
                WIDENED_THRESHOLD - ((WIDENED_THRESHOLD - 1) * (round + 1)) / SHRINK_ROUNDS,
            );
            const next = select(refined, points, limits, factor);
            const settled = factor === 1 && sameSet(next.inliers, current.inliers);
            matrix = refined;
            current = next;
            if (settled) break;
        }
        const final = select(matrix, points, limits, 1);
        return final.count >= sampleSize ? { matrix, ...final } : null;
    }
}

function select(
    matrix: Mat3,
    points: readonly Correspondence[],
    limits: readonly number[],
    factor: number,
): Selection {
    const inverse = mat3Inverse(matrix);
    const inliers = new Uint8Array(points.length);
    let count = 0;
    let error = 0;
    for (let i = 0; i < points.length; i++) {
        const e = symmetricTransferError(matrix, inverse, points[i]);
        if (e > limits[i] * factor) continue;
        inliers[i] = 1;
        count++;
        error += e;
    }
    return { inliers, count, error };
}

function sameSet(a: Uint8Array, b: Uint8Array): boolean {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}
