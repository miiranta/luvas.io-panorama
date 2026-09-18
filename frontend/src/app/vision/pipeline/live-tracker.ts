import { PreviewPayload } from '../../core/models/reports';
import { ColorImage } from '../foundation/imaging/image';
import { FeatureExtractor } from './feature-extractor';
import { Keyframe } from './keyframe';
import { KeyframeStore } from './keyframe-store';
import { FittedPair, PairLinker, isFitted } from './pair-linker';

const PREVIEW_KEYPOINTS = 320;
const PREVIEW_SCALE_LEVELS = 1;
const PREVIEW_CANDIDATES = 3;
const MIN_PREVIEW_KEYPOINTS = 8;

export class LiveTracker {
    constructor(
        private readonly frames: KeyframeStore,
        private readonly features: FeatureExtractor,
        private readonly linker: PairLinker,
    ) {}

    track(work: ColorImage): PreviewPayload | null {
        const anchors = this.frames.active.filter((frame) => frame.keypoints.length > 0);
        const latest = anchors.at(-1);
        if (!latest) return null;
        const { keypoints, descriptors } = this.features.extract(
            work,
            PREVIEW_KEYPOINTS,
            PREVIEW_SCALE_LEVELS,
        );
        if (keypoints.length < MIN_PREVIEW_KEYPOINTS) return null;
        const probe = new Keyframe(
            -1,
            'preview',
            work.width,
            work.height,
            keypoints,
            descriptors,
            null,
            null,
            latest.rotation,
        );
        let best: { frame: Keyframe; pair: FittedPair } | null = null;
        for (const frame of this.frames.nearest(probe.rotation, PREVIEW_CANDIDATES, anchors)) {
            const pair = this.linker.match(probe, frame);
            if (!isFitted(pair)) continue;
            if (!best || pair.fit.inlierCount > best.pair.fit.inlierCount) best = { frame, pair };
        }
        if (!best) return null;
        const { frame, pair } = best;
        const scale = work.width / frame.workWidth;
        const accepted = pair.matches.filter((match) => match.accepted).length;
        return {
            width: work.width,
            height: work.height,
            referenceLabel: frame.label,
            vectors: pair.correspondences.map((c, index) => ({
                fx: c.dx * scale,
                fy: c.dy * scale,
                tx: c.sx,
                ty: c.sy,
                inlier: pair.fit.inliers[index] === 1,
            })),
            inliers: pair.fit.inlierCount,
            meanError: pair.fit.meanError,
            verified: this.linker.verified(pair.fit.inlierCount, accepted, false),
        };
    }
}
