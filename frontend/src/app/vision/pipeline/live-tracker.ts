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
    private lastReference = -1;
    private newestSeen = -1;

    constructor(
        private readonly frames: KeyframeStore,
        private readonly features: FeatureExtractor,
        private readonly linker: PairLinker,
    ) {}

    track(work: ColorImage): PreviewPayload | null {
        const anchors = this.frames.active.filter((frame) => frame.keypoints.length > 0);
        const latest = anchors.at(-1);
        if (!latest) return null;
        if (latest.id !== this.newestSeen) {
            this.newestSeen = latest.id;
            this.lastReference = latest.id;
        }
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
        const nearest = this.frames.nearest(probe.rotation, PREVIEW_CANDIDATES, anchors);
        const sticky = anchors.find((frame) => frame.id === this.lastReference);
        const candidates = sticky
            ? [sticky, ...nearest.filter((frame) => frame !== sticky)]
            : nearest;
        let best: { frame: Keyframe; pair: FittedPair; verified: boolean } | null = null;
        for (const frame of candidates) {
            const pair = this.linker.match(probe, frame, { crossCheck: false });
            if (!isFitted(pair)) continue;
            const accepted = pair.matches.filter((match) => match.accepted).length;
            const verified = this.linker.verified(pair.fit.inlierCount, accepted, false);
            if (verified) {
                best = { frame, pair, verified };
                break;
            }
            if (!best || pair.fit.inlierCount > best.pair.fit.inlierCount) {
                best = { frame, pair, verified };
            }
        }
        if (!best) return null;
        const { frame, pair, verified } = best;
        this.lastReference = frame.id;
        const scale = work.width / frame.workWidth;
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
            verified,
        };
    }
}
