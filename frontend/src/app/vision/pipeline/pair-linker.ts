import { PipelineParams } from '../../core/models/params';
import { MatchRecord, PairReport } from '../../core/models/reports';
import { DescriptorMatcher } from '../features/descriptor-matcher';
import { BundleObservation } from '../geometry/bundle-adjuster';
import { brownLoweVerified } from '../geometry/pose-graph';
import { ModelFit, RansacEstimator } from '../geometry/ransac';
import { focalFromHomography } from '../geometry/rotational-camera';
import { Correspondence } from '../geometry/transform-model';
import { ColorImage } from '../imaging/image';
import { Mat3 } from '../math/matrix3';
import { Keyframe } from './keyframe';
import { IntensitySample, PairLink } from './pair-link';

const MAX_OBSERVATIONS_PER_PAIR = 120;
const INTENSITY_PATCH_RADIUS = 3;
const MIN_CORRESPONDENCES = 4;
const OVERLAP_SAMPLES = 24;
const MAX_INTENSITY_SAMPLES = 400;

export interface PairMatch {
    fit: ModelFit | null;
    matches: MatchRecord[];
    correspondences: Correspondence[];
}

export type FittedPair = PairMatch & { fit: ModelFit };

export function isFitted(pair: PairMatch): pair is FittedPair {
    return pair.fit !== null;
}

export class PairLinker {
    constructor(
        private readonly params: () => PipelineParams,
        private readonly matcher: () => DescriptorMatcher,
    ) {}

    match(query: Keyframe, train: Keyframe): PairMatch {
        const raw = this.matcher().match(
            query.descriptors,
            query.keypoints.length,
            train.descriptors,
            train.keypoints.length,
            this.params().match,
        );
        const correspondences: Correspondence[] = [];
        const origin: number[] = [];
        raw.forEach((match, index) => {
            if (!match.accepted) return;
            const q = query.keypoints[match.queryIndex];
            const t = train.keypoints[match.trainIndex];
            correspondences.push({ sx: q.x, sy: q.y, dx: t.x, dy: t.y });
            origin.push(index);
        });
        const fit =
            correspondences.length >= MIN_CORRESPONDENCES
                ? new RansacEstimator(this.params().model).fit(correspondences)
                : null;
        const matches: MatchRecord[] = raw.map((match) => ({ ...match, inlier: false }));
        if (fit) {
            correspondences.forEach((_, c) => {
                if (fit.inliers[c]) matches[origin[c]].inlier = true;
            });
        }
        return { fit, matches, correspondences };
    }

    verified(inliers: number, accepted: number, requireRatio = true): boolean {
        const model = this.params().model;
        const ratio = accepted === 0 ? 0 : inliers / accepted;
        return (
            inliers >= model.minInliers &&
            (!requireRatio || ratio >= model.minInlierRatio) &&
            brownLoweVerified(inliers, accepted)
        );
    }

    link(query: Keyframe, train: Keyframe, pair: FittedPair): PairLink {
        const { fit, correspondences } = pair;
        const accepted = pair.matches.filter((match) => match.accepted).length;
        const intensities = intensitySamples(query, train, pair);
        const [meanIntensityA, meanIntensityB] = meanIntensities(intensities);
        return {
            a: query.id,
            b: train.id,
            matches: accepted,
            inliers: fit.inlierCount,
            meanError: fit.meanError,
            verified: this.verified(fit.inlierCount, accepted),
            focal: focalFromHomography(fit.matrix, query.centreX, query.centreY),
            matrix: fit.matrix,
            observations: sampleObservations(query.id, train.id, correspondences, fit),
            meanIntensityA,
            meanIntensityB,
            overlapPixels: overlapArea(query, train, fit.matrix),
            intensities,
        };
    }

    report(train: Keyframe, pair: PairMatch, link: PairLink | null): PairReport {
        const accepted = pair.matches.filter((match) => match.accepted).length;
        return {
            trainId: train.id,
            inliers: link?.inliers ?? 0,
            inlierRatio: link && accepted > 0 ? link.inliers / accepted : 0,
            meanError: pair.fit?.meanError ?? Number.POSITIVE_INFINITY,
            verified: link?.verified ?? false,
        };
    }
}

function sampleObservations(
    cameraA: number,
    cameraB: number,
    correspondences: readonly Correspondence[],
    fit: ModelFit,
): BundleObservation[] {
    const observations: BundleObservation[] = [];
    const stride = Math.max(1, Math.floor(fit.inlierCount / MAX_OBSERVATIONS_PER_PAIR));
    let kept = 0;
    correspondences.forEach((pair, c) => {
        if (!fit.inliers[c]) return;
        kept++;
        if (kept % stride !== 0) return;
        observations.push({ cameraA, cameraB, ax: pair.sx, ay: pair.sy, bx: pair.dx, by: pair.dy });
    });
    return observations;
}

function overlapArea(query: Keyframe, train: Keyframe, matrix: Mat3): number {
    let inside = 0;
    let total = 0;
    for (let row = 0; row < OVERLAP_SAMPLES; row++) {
        for (let column = 0; column < OVERLAP_SAMPLES; column++) {
            const sx = ((column + 0.5) / OVERLAP_SAMPLES) * query.workWidth;
            const sy = ((row + 0.5) / OVERLAP_SAMPLES) * query.workHeight;
            const w = matrix[6] * sx + matrix[7] * sy + matrix[8];
            total++;
            if (Math.abs(w) < 1e-9) continue;
            const dx = (matrix[0] * sx + matrix[1] * sy + matrix[2]) / w;
            const dy = (matrix[3] * sx + matrix[4] * sy + matrix[5]) / w;
            if (dx >= 0 && dy >= 0 && dx < train.workWidth && dy < train.workHeight) inside++;
        }
    }
    if (total === 0) return 0;
    return (inside / total) * query.workWidth * query.workHeight;
}

function intensitySamples(query: Keyframe, train: Keyframe, pair: FittedPair): IntensitySample[] {
    const samples: IntensitySample[] = [];
    if (!query.work || !train.work) return samples;
    const stride = Math.max(1, Math.floor(pair.fit.inlierCount / MAX_INTENSITY_SAMPLES));
    let seen = 0;
    pair.correspondences.forEach((c, index) => {
        if (!pair.fit.inliers[index] || !query.work || !train.work) return;
        seen++;
        if (seen % stride !== 0) return;
        const a = patchMean(query.work, c.sx, c.sy);
        const b = patchMean(train.work, c.dx, c.dy);
        if (a === null || b === null) return;
        samples.push({ ax: c.sx, ay: c.sy, intensityA: a, bx: c.dx, by: c.dy, intensityB: b });
    });
    return samples;
}

function meanIntensities(samples: readonly IntensitySample[]): [number, number] {
    if (samples.length === 0) return [1, 1];
    let sumA = 0;
    let sumB = 0;
    for (const sample of samples) {
        sumA += sample.intensityA;
        sumB += sample.intensityB;
    }
    return [sumA / samples.length, sumB / samples.length];
}

function patchMean(image: ColorImage, x: number, y: number): number | null {
    const cx = Math.round(x);
    const cy = Math.round(y);
    let sum = 0;
    let count = 0;
    for (let dy = -INTENSITY_PATCH_RADIUS; dy <= INTENSITY_PATCH_RADIUS; dy++) {
        const py = cy + dy;
        if (py < 0 || py >= image.height) continue;
        for (let dx = -INTENSITY_PATCH_RADIUS; dx <= INTENSITY_PATCH_RADIUS; dx++) {
            const px = cx + dx;
            if (px < 0 || px >= image.width) continue;
            const i = (py * image.width + px) * 4;
            sum += 0.299 * image.data[i] + 0.587 * image.data[i + 1] + 0.114 * image.data[i + 2];
            count++;
        }
    }
    return count === 0 ? null : sum / count;
}
