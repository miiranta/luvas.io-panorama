import { PipelineParams } from '../../core/models/params';
import {
    ExposureCompensator,
    OverlapIntensity,
} from '../compositing/photometric/exposure-compensator';
import {
    GAIN_CELLS,
    GAIN_COLUMNS,
    GAIN_ROWS,
    gainCell,
    smoothGainGrid,
} from '../compositing/photometric/gain-grid';
import {
    VignettingSample,
    estimateVignetting,
    vignetteAt,
} from '../compositing/photometric/vignetting';
import { Rgb, UNIT_RGB, luma } from '../foundation/imaging/image';
import { median } from '../foundation/math/median';
import { CameraSolver } from './camera-solver';
import { Keyframe } from './keyframe';
import { KeyframeStore } from './keyframe-store';
import { LinkRegistry } from './link-registry';
import { PairLink } from './pair-link';

const CHANNELS = [0, 1, 2] as const;
const DARK_LIMIT = 8;
const BRIGHT_LIMIT = 245;
const OUTLIER_LOG_RATIO = Math.log(1.35);
const BLOCK_SMOOTHING = 2;
const MIN_BLOCK_GAIN = 0.7;
const MAX_BLOCK_GAIN = 1.4;

interface OverlapColor {
    a: number;
    b: number;
    meanA: Rgb;
    meanB: Rgb;
    weight: number;
}

interface CorrectedSample {
    ax: number;
    ay: number;
    bx: number;
    by: number;
    colorA: Rgb;
    colorB: Rgb;
}

interface BlockPair {
    a: number;
    b: number;
    sumA: number;
    sumB: number;
    count: number;
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

function scaled(color: Rgb, factor: number): Rgb {
    return [color[0] * factor, color[1] * factor, color[2] * factor];
}

function gainedLuma(color: Rgb, gain: Rgb): number {
    return luma(color[0] * gain[0], color[1] * gain[1], color[2] * gain[2]);
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
            for (const frame of this.frames.all) {
                frame.gain = UNIT_RGB;
                frame.gainGrid = null;
            }
            return;
        }
        const samples = new Map<PairLink, CorrectedSample[]>();
        const overlaps = this.links.verified.flatMap((link): OverlapColor[] => {
            const a = indexOf.get(link.a);
            const b = indexOf.get(link.b);
            if (a === undefined || b === undefined) return [];
            const kept = this.consistentSamples(link, active[a], active[b]);
            if (kept.length === 0) return [];
            samples.set(link, kept);
            const [meanA, meanB] = this.meanColors(kept);
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
        this.calibrateBlocks(active, indexOf, samples);
    }

    private calibrateBlocks(
        active: Keyframe[],
        indexOf: Map<number, number>,
        samples: Map<PairLink, CorrectedSample[]>,
    ): void {
        for (const frame of this.frames.all) frame.gainGrid = null;
        if (!this.params().compose.blockGains) return;
        const pairs = new Map<number, BlockPair>();
        const blocks = active.length * GAIN_CELLS;
        for (const [link, kept] of samples) {
            const a = indexOf.get(link.a) as number;
            const b = indexOf.get(link.b) as number;
            const frameA = active[a];
            const frameB = active[b];
            for (const sample of kept) {
                const blockA =
                    a * GAIN_CELLS +
                    gainCell(sample.ax, sample.ay, frameA.workWidth, frameA.workHeight);
                const blockB =
                    b * GAIN_CELLS +
                    gainCell(sample.bx, sample.by, frameB.workWidth, frameB.workHeight);
                const key = blockA * blocks + blockB;
                let pair = pairs.get(key);
                if (!pair) {
                    pair = { a: blockA, b: blockB, sumA: 0, sumB: 0, count: 0 };
                    pairs.set(key, pair);
                }
                pair.sumA += gainedLuma(sample.colorA, frameA.gain);
                pair.sumB += gainedLuma(sample.colorB, frameB.gain);
                pair.count++;
            }
        }
        if (pairs.size === 0) return;
        const gains = this.exposure.solve(
            [...pairs.values()].map((pair) => ({
                a: pair.a,
                b: pair.b,
                meanA: Math.max(1, pair.sumA / pair.count),
                meanB: Math.max(1, pair.sumB / pair.count),
                weight: pair.count,
            })),
            blocks,
        );
        active.forEach((frame, index) => {
            const values = smoothGainGrid(
                gains.subarray(index * GAIN_CELLS, (index + 1) * GAIN_CELLS),
                GAIN_COLUMNS,
                GAIN_ROWS,
                BLOCK_SMOOTHING,
            );
            for (let i = 0; i < values.length; i++) {
                values[i] = Math.min(MAX_BLOCK_GAIN, Math.max(MIN_BLOCK_GAIN, values[i]));
            }
            frame.gainGrid = { columns: GAIN_COLUMNS, rows: GAIN_ROWS, values };
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

    private consistentSamples(
        link: PairLink,
        frameA: Keyframe,
        frameB: Keyframe,
    ): CorrectedSample[] {
        const beta = this.vignetting;
        const corrected = link.intensities.flatMap((sample): CorrectedSample[] => {
            const lumaA = luma(...sample.colorA);
            const lumaB = luma(...sample.colorB);
            if (Math.min(lumaA, lumaB) < DARK_LIMIT || Math.max(lumaA, lumaB) > BRIGHT_LIMIT) {
                return [];
            }
            const falloffA = vignetteAt(this.radiusSquared(frameA, sample.ax, sample.ay), beta);
            const falloffB = vignetteAt(this.radiusSquared(frameB, sample.bx, sample.by), beta);
            return [
                {
                    ax: sample.ax,
                    ay: sample.ay,
                    bx: sample.bx,
                    by: sample.by,
                    colorA: scaled(sample.colorA, 1 / falloffA),
                    colorB: scaled(sample.colorB, 1 / falloffB),
                },
            ];
        });
        const ratios = corrected.map((sample) =>
            Math.log(luma(...sample.colorA) / luma(...sample.colorB)),
        );
        const center = median(ratios);
        if (center === null) return [];
        return corrected.filter((_, i) => Math.abs(ratios[i] - center) <= OUTLIER_LOG_RATIO);
    }

    private meanColors(samples: readonly CorrectedSample[]): [Rgb, Rgb] {
        const sumA = [0, 0, 0];
        const sumB = [0, 0, 0];
        for (const sample of samples) {
            for (const c of CHANNELS) {
                sumA[c] += sample.colorA[c];
                sumB[c] += sample.colorB[c];
            }
        }
        const count = samples.length;
        return [
            [sumA[0] / count, sumA[1] / count, sumA[2] / count],
            [sumB[0] / count, sumB[1] / count, sumB[2] / count],
        ];
    }
}
