import { MatchParams, PipelineParams } from '../../core/models/params';
import { MatchRecord, PairReport } from '../../core/models/reports';
import { DescriptorMatcher } from '../features/matching/descriptor-matcher';
import { BundleObservation } from '../registration/alignment/bundle-adjuster';
import { brownLoweVerified } from '../registration/alignment/pose-graph';
import { ModelFit, RansacEstimator } from '../registration/estimation/ransac-estimator';
import { focalFromHomography } from '../registration/alignment/rotational-camera';
import { undistort } from '../registration/alignment/lens-distortion';
import { Correspondence } from '../registration/estimation/correspondence';
import { ColorImage } from '../foundation/imaging/image';
import { Mat3 } from '../foundation/math/matrix3';
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

export interface LensModel {
    focal(frame: Keyframe): number;
    distortion: number;
}

const NO_LENS: LensModel = { focal: () => 1, distortion: 0 };

export class PairLinker {
    private readonly scratch = new Float64Array(2);

    constructor(
        private readonly params: () => PipelineParams,
        private readonly matcher: () => DescriptorMatcher,
        private readonly lens: () => LensModel = () => NO_LENS,
    ) {}

    match(query: Keyframe, train: Keyframe, overrides: Partial<MatchParams> = {}): PairMatch {
        const raw = this.matcher().match(
            query.descriptors,
            query.keypoints.length,
            train.descriptors,
            train.keypoints.length,
            { ...this.params().match, ...overrides },
        );
        const correspondences: Correspondence[] = [];
        const origin: number[] = [];
        raw.forEach((match, index) => {
            if (!match.accepted) return;
            const q = query.keypoints[match.queryIndex];
            const t = train.keypoints[match.trainIndex];
            correspondences.push({
                sx: q.x,
                sy: q.y,
                dx: t.x,
                dy: t.y,
                sourceScale: q.scale,
                targetScale: t.scale,
            });
            origin.push(index);
        });
        const fit =
            correspondences.length >= MIN_CORRESPONDENCES
                ? new RansacEstimator(this.params().model).fit(
                      this.rectify(correspondences, query, train),
                  )
                : null;
        const matches: MatchRecord[] = raw.map((match) => ({ ...match, inlier: false }));
        if (fit) {
            correspondences.forEach((_, c) => {
                if (fit.inliers[c]) matches[origin[c]].inlier = true;
            });
        }
        return { fit, matches, correspondences };
    }

    private rectify(
        correspondences: readonly Correspondence[],
        query: Keyframe,
        train: Keyframe,
    ): Correspondence[] {
        const lens = this.lens();
        if (lens.distortion === 0) return correspondences.slice();
        const queryFocal = lens.focal(query);
        const trainFocal = lens.focal(train);
        return correspondences.map((c) => {
            const [sx, sy] = this.undistortPoint(c.sx, c.sy, query, queryFocal, lens.distortion);
            const [dx, dy] = this.undistortPoint(c.dx, c.dy, train, trainFocal, lens.distortion);
            return { ...c, sx, sy, dx, dy };
        });
    }

    private undistortPoint(
        x: number,
        y: number,
        frame: Keyframe,
        focal: number,
        distortion: number,
    ): [number, number] {
        undistort(
            (x - frame.centerX) / focal,
            (y - frame.centerY) / focal,
            distortion,
            this.scratch,
        );
        return [frame.centerX + focal * this.scratch[0], frame.centerY + focal * this.scratch[1]];
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
            focal: focalFromHomography(fit.matrix, query.centerX, query.centerY),
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

function sampleInliers<T>(items: readonly T[], fit: ModelFit, limit: number): T[] {
    const stride = Math.max(1, Math.floor(fit.inlierCount / limit));
    const sampled: T[] = [];
    let kept = 0;
    items.forEach((item, index) => {
        if (!fit.inliers[index]) return;
        kept++;
        if (kept % stride === 0) sampled.push(item);
    });
    return sampled;
}

function sampleObservations(
    cameraA: number,
    cameraB: number,
    correspondences: readonly Correspondence[],
    fit: ModelFit,
): BundleObservation[] {
    return sampleInliers(correspondences, fit, MAX_OBSERVATIONS_PER_PAIR).map((pair) => ({
        cameraA,
        cameraB,
        ax: pair.sx,
        ay: pair.sy,
        bx: pair.dx,
        by: pair.dy,
        scaleA: pair.sourceScale ?? 1,
        scaleB: pair.targetScale ?? 1,
    }));
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
    const queryWork = query.work;
    const trainWork = train.work;
    if (!queryWork || !trainWork) return [];
    return sampleInliers(pair.correspondences, pair.fit, MAX_INTENSITY_SAMPLES).flatMap((c) => {
        const intensityA = patchMean(queryWork, c.sx, c.sy);
        const intensityB = patchMean(trainWork, c.dx, c.dy);
        if (intensityA === null || intensityB === null) return [];
        return [{ ax: c.sx, ay: c.sy, intensityA, bx: c.dx, by: c.dy, intensityB }];
    });
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
