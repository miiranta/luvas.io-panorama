import { PipelineParams } from '../../core/models/params';
import { ExposureCompensator } from '../compositing/photometric/exposure-compensator';
import {
    VignettingSample,
    estimateVignetting,
    vignetteAt,
} from '../compositing/photometric/vignetting';
import { CameraSolver } from './camera-solver';
import { Keyframe } from './keyframe';
import { KeyframeStore } from './keyframe-store';
import { LinkRegistry } from './link-registry';
import { PairLink } from './pair-link';

export class PhotometricCalibrator {
    private vignettingEstimate = 0;
    private readonly exposure = new ExposureCompensator();

    constructor(
        private readonly params: () => PipelineParams,
        private readonly frames: KeyframeStore,
        private readonly links: LinkRegistry,
        private readonly cameras: CameraSolver,
    ) {}

    get vignetting(): number {
        return this.params().compose.vignetting ? this.vignettingEstimate : 0;
    }

    reset(): void {
        this.vignettingEstimate = 0;
    }

    calibrate(active: Keyframe[]): void {
        const indexOf = new Map(active.map((frame, index) => [frame.id, index]));
        this.estimateVignetting(active, indexOf);
        if (!this.params().compose.exposureCompensation || active.length === 0) {
            for (const frame of this.frames.all) frame.gain = 1;
            return;
        }
        const pairs = this.links.verified.flatMap((link) => {
            const a = indexOf.get(link.a);
            const b = indexOf.get(link.b);
            if (a === undefined || b === undefined || link.intensities.length === 0) return [];
            const [meanA, meanB] = this.correctedMeans(link, active[a], active[b]);
            return [
                {
                    a,
                    b,
                    meanA: Math.max(1, meanA),
                    meanB: Math.max(1, meanB),
                    weight: Math.max(1, link.overlapPixels),
                },
            ];
        });
        const gains = this.exposure.solve(pairs, active.length);
        active.forEach((frame, index) => {
            frame.gain = gains[index];
        });
    }

    private radiusSquared(frame: Keyframe, x: number, y: number): number {
        const focal = this.cameras.focalFor(frame);
        const dx = (x - frame.centerX) / focal;
        const dy = (y - frame.centerY) / focal;
        return dx * dx + dy * dy;
    }

    private estimateVignetting(active: Keyframe[], indexOf: Map<number, number>): void {
        if (!this.params().compose.vignetting) {
            this.vignettingEstimate = 0;
            return;
        }
        const samples: VignettingSample[] = [];
        for (const link of this.links.verified) {
            const a = indexOf.get(link.a);
            const b = indexOf.get(link.b);
            if (a === undefined || b === undefined) continue;
            for (const sample of link.intensities) {
                samples.push({
                    a,
                    b,
                    radiusSquaredA: this.radiusSquared(active[a], sample.ax, sample.ay),
                    radiusSquaredB: this.radiusSquared(active[b], sample.bx, sample.by),
                    intensityA: sample.intensityA,
                    intensityB: sample.intensityB,
                });
            }
        }
        this.vignettingEstimate = estimateVignetting(samples, active.length);
    }

    private correctedMeans(link: PairLink, frameA: Keyframe, frameB: Keyframe): [number, number] {
        const beta = this.vignetting;
        if (beta === 0 || link.intensities.length === 0) {
            return [link.meanIntensityA, link.meanIntensityB];
        }
        let sumA = 0;
        let sumB = 0;
        for (const sample of link.intensities) {
            sumA +=
                sample.intensityA /
                vignetteAt(this.radiusSquared(frameA, sample.ax, sample.ay), beta);
            sumB +=
                sample.intensityB /
                vignetteAt(this.radiusSquared(frameB, sample.bx, sample.by), beta);
        }
        return [sumA / link.intensities.length, sumB / link.intensities.length];
    }
}
