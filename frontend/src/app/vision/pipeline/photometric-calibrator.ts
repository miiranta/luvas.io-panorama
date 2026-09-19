import { PipelineParams } from '../../core/models/params';
import {
    ExposureCompensator,
    OverlapIntensity,
} from '../compositing/photometric/exposure-compensator';
import {
    VignettingSample,
    estimateVignetting,
    vignetteAt,
} from '../compositing/photometric/vignetting';
import { Rgb, UNIT_RGB, luma } from '../foundation/imaging/image';
import { CameraSolver } from './camera-solver';
import { Keyframe } from './keyframe';
import { KeyframeStore } from './keyframe-store';
import { LinkRegistry } from './link-registry';
import { PairLink } from './pair-link';

const CHANNELS = [0, 1, 2] as const;

interface OverlapColor {
    a: number;
    b: number;
    meanA: Rgb;
    meanB: Rgb;
    weight: number;
}

function channelOf(overlap: OverlapColor, channel: number): OverlapIntensity {
    return {
        a: overlap.a,
        b: overlap.b,
        meanA: Math.max(1, overlap.meanA[channel]),
        meanB: Math.max(1, overlap.meanB[channel]),
        weight: overlap.weight,
    };
}

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
            for (const frame of this.frames.all) frame.gain = UNIT_RGB;
            return;
        }
        const overlaps = this.links.verified.flatMap((link): OverlapColor[] => {
            const a = indexOf.get(link.a);
            const b = indexOf.get(link.b);
            if (a === undefined || b === undefined || link.intensities.length === 0) return [];
            const [meanA, meanB] = this.meanColors(link, active[a], active[b]);
            return [{ a, b, meanA, meanB, weight: Math.max(1, link.overlapPixels) }];
        });
        const [red, green, blue] = CHANNELS.map((channel) =>
            this.exposure.solve(
                overlaps.map((overlap) => channelOf(overlap, channel)),
                active.length,
            ),
        );
        active.forEach((frame, index) => {
            frame.gain = [red[index], green[index], blue[index]];
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
                    intensityA: luma(...sample.colorA),
                    intensityB: luma(...sample.colorB),
                });
            }
        }
        this.vignettingEstimate = estimateVignetting(samples, active.length);
    }

    private meanColors(link: PairLink, frameA: Keyframe, frameB: Keyframe): [Rgb, Rgb] {
        const beta = this.vignetting;
        const sumA = [0, 0, 0];
        const sumB = [0, 0, 0];
        for (const sample of link.intensities) {
            const falloffA = vignetteAt(this.radiusSquared(frameA, sample.ax, sample.ay), beta);
            const falloffB = vignetteAt(this.radiusSquared(frameB, sample.bx, sample.by), beta);
            for (const c of CHANNELS) {
                sumA[c] += sample.colorA[c] / falloffA;
                sumB[c] += sample.colorB[c] / falloffB;
            }
        }
        const count = link.intensities.length;
        return [
            [sumA[0] / count, sumA[1] / count, sumA[2] / count],
            [sumB[0] / count, sumB[1] / count, sumB[2] / count],
        ];
    }
}
