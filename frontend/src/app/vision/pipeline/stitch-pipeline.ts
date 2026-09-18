import { DEFAULT_PARAMS, PipelineParams } from '../../core/models/params';
import {
    ConnectionPayload,
    FrameReport,
    GraphPayload,
    MatchRecord,
    MosaicPayload,
    PairReport,
    PreviewPayload,
    StageTimings,
} from '../../core/models/reports';
import { ColorImage } from '../imaging/image';
import { Mat3, mat3Identity } from '../math/matrix3';
import { axisAngleFromRotation, rotationAngleBetween } from '../math/so3';
import { AcceleratorSuite } from './accelerator-suite';
import { CameraSolver } from './camera-solver';
import { FeatureExtractor } from './feature-extractor';
import { Keyframe } from './keyframe';
import { KeyframeStore } from './keyframe-store';
import { LinkRegistry } from './link-registry';
import { LiveTracker } from './live-tracker';
import { MosaicCompositor, RasterImage } from './mosaic-compositor';
import { PairLink } from './pair-link';
import { PairLinker, isFitted } from './pair-linker';

const PAYLOAD_MARGIN = 4;
const INTRUDER_REASON = 'sem sobreposição suficiente com as câmeras vizinhas (imagem intrusa)';

interface Candidate {
    frame: Keyframe;
    matches: MatchRecord[];
    report: PairReport;
}

export interface FrameOutcome {
    report: FrameReport;
    connection: ConnectionPayload | null;
}

export class StitchPipeline {
    private params: PipelineParams = DEFAULT_PARAMS;
    private readonly frames = new KeyframeStore();
    private readonly links = new LinkRegistry();
    private readonly accelerators = new AcceleratorSuite(() => this.params);
    private readonly cameras = new CameraSolver(() => this.params.global);
    private readonly linker = new PairLinker(
        () => this.params,
        () => this.accelerators.matcher(),
    );
    private readonly features = new FeatureExtractor(
        () => this.params,
        () => this.accelerators.detector(),
    );
    private readonly compositor = new MosaicCompositor(
        () => this.params,
        () => this.accelerators.blur(),
        this.frames,
        this.links,
        this.cameras,
    );
    private readonly tracker = new LiveTracker(this.frames, this.features, this.linker);

    setParams(params: PipelineParams): void {
        this.params = params;
    }

    get frameCount(): number {
        return this.frames.active.length;
    }

    reset(): void {
        this.frames.clear();
        this.links.clear();
        this.cameras.reset();
        this.compositor.reset();
    }

    previewMatch(work: ColorImage): PreviewPayload | null {
        return this.tracker.track(work);
    }

    recompose(): Promise<void> {
        return this.compositor.recompose();
    }

    async addFrame(label: string, work: ColorImage, compose: ColorImage): Promise<FrameOutcome> {
        const started = performance.now();
        const extracted = this.features.extract(work);
        const previous = this.frames.latestActive();
        const frame = new Keyframe(
            this.frames.allocateId(),
            label,
            work.width,
            work.height,
            extracted.keypoints,
            extracted.descriptors,
            work,
            compose,
            previous ? (Float64Array.from(previous.rotation) as Mat3) : mat3Identity(),
        );
        const timings: StageTimings = {
            detect: extracted.detectMs,
            describe: extracted.describeMs,
            match: 0,
            model: 0,
            bundle: 0,
            compose: 0,
            total: 0,
        };
        const report = this.emptyReport(frame, timings);
        const finish = async (connection: ConnectionPayload | null): Promise<FrameOutcome> => {
            timings.total = performance.now() - started;
            report.coveragePercent = this.compositor.coveragePercent();
            await this.frames.trim();
            return { report, connection };
        };

        if (!previous) {
            this.frames.add(frame);
            this.cameras.initialise(frame);
            report.focal = this.cameras.focal ?? 0;
            const composing = performance.now();
            await this.compositor.recompose();
            timings.compose = performance.now() - composing;
            return finish(null);
        }

        this.frames.add(frame);
        const matching = performance.now();
        const { best, closest, links } = this.linkToNeighbours(frame, report);
        timings.match = performance.now() - matching;

        if (!best) {
            const connection = closest ? this.connection(frame, closest) : null;
            this.reject(frame, report, INTRUDER_REASON);
            return finish(connection);
        }

        const modelling = performance.now();
        const parent = best.candidate.frame;
        this.cameras.absorbFocals(links, frame, true);
        frame.rotation = this.cameras.placeRelativeTo(frame, parent, best.link);
        this.links.add(...links);
        timings.model = performance.now() - modelling;
        const connection = this.connection(frame, best.candidate);

        const angle = (rotationAngleBetween(frame.rotation, parent.rotation) * 180) / Math.PI;
        const minAngle = this.params.global.keyframeMinAngle;
        if (minAngle > 0 && angle < minAngle && this.frameCount > 1) {
            this.reject(
                frame,
                report,
                `cobertura nova de apenas ${angle.toFixed(1)}° (abaixo do limiar de keyframe)`,
            );
            this.links.replace(
                this.links.all.filter((link) => link.a !== frame.id && link.b !== frame.id),
            );
            return finish(connection);
        }

        const adjusting = performance.now();
        const bundle = this.cameras.adjust(
            this.frames.active,
            this.links,
            this.bundleFreeIds(frame),
        );
        timings.bundle = performance.now() - adjusting;

        const composing = performance.now();
        await this.compositor.integrate();
        timings.compose = performance.now() - composing;

        const [pitch, yaw] = axisAngleFromRotation(frame.rotation).map(
            (radians) => (radians * 180) / Math.PI,
        );
        Object.assign(report, {
            focal: this.cameras.focal ?? 0,
            yaw,
            pitch,
            bundleBefore: bundle.before,
            bundleAfter: bundle.after,
        });
        const stats = this.compositor.statsFor(frame.id);
        if (stats) {
            report.overlapPixels = stats.overlapPixels;
            report.inconsistentPixels = stats.inconsistentPixels;
        }
        return finish(connection);
    }

    async resolveFromScratch(): Promise<void> {
        const all = this.frames.all;
        for (const frame of all) frame.rejected = false;
        const links: PairLink[] = [];
        for (let i = 0; i < all.length; i++) {
            for (let j = i + 1; j < all.length; j++) {
                const pair = this.linker.match(all[i], all[j]);
                if (!isFitted(pair)) continue;
                const link = this.linker.link(all[i], all[j], pair);
                if (link.inliers > 0) links.push(link);
            }
        }
        this.links.replace(links);
        if (all.length > 0) this.cameras.absorbFocals(links, all[0], false);

        const graph = this.links.poseGraph(all);
        all.forEach((frame, index) => {
            if (graph.inMainComponent(index)) return;
            frame.rejected = true;
            frame.work = null;
        });
        for (const index of graph.traversal) all[index].rotation = mat3Identity();
        const placed = new Set<number>([graph.reference]);
        for (const index of graph.traversal) {
            const frame = all[index];
            if (index === graph.reference || frame.rejected) continue;
            const parentIndex = graph.strongestPlacedNeighbour(index, placed);
            if (parentIndex < 0) continue;
            const parent = all[parentIndex];
            const link = this.links.between(frame.id, parent.id);
            if (!link) continue;
            frame.rotation = this.cameras.placeRelativeTo(frame, parent, link);
            placed.add(index);
        }
        const active = this.frames.active;
        this.cameras.adjust(
            active,
            this.links,
            active.map((frame) => frame.id),
        );
        await this.compositor.recompose();
    }

    graph(): GraphPayload {
        return this.links.payload(this.frames.all);
    }

    coveragePercent(): number {
        return this.compositor.coveragePercent();
    }

    mosaicPayload(): MosaicPayload | null {
        const image = this.compositor.render(true, PAYLOAD_MARGIN);
        if (!image) return null;
        const span = this.compositor.span();
        return {
            ...image,
            ...this.accelerators.labels(),
            storedBytes: this.frames.storedBytes,
            fillPercent: this.compositor.coveragePercent(),
            spanHorizontal: span.horizontal,
            spanVertical: span.vertical,
            focal: this.cameras.focal ?? 0,
            frames: this.frameCount,
            surface: this.params.compose.surface,
        };
    }

    exportImage(): RasterImage | null {
        return this.compositor.render(this.params.compose.crop);
    }

    private linkToNeighbours(
        frame: Keyframe,
        report: FrameReport,
    ): {
        best: { link: PairLink; candidate: Candidate } | null;
        closest: Candidate | null;
        links: PairLink[];
    } {
        let best: { link: PairLink; candidate: Candidate } | null = null;
        let closest: Candidate | null = null;
        const links: PairLink[] = [];
        for (const neighbour of this.neighbours(frame)) {
            const pair = this.linker.match(frame, neighbour);
            const link = isFitted(pair) ? this.linker.link(frame, neighbour, pair) : null;
            const pairReport = this.linker.report(neighbour, pair, link);
            const candidate = { frame: neighbour, matches: pair.matches, report: pairReport };
            report.pairs.push(pairReport);
            if (!closest || pairReport.inliers > closest.report.inliers) closest = candidate;
            if (!link) continue;
            links.push(link);
            if (link.verified && (!best || link.inliers > best.link.inliers)) {
                best = { link, candidate };
            }
        }
        return { best, closest, links };
    }

    private neighbours(frame: Keyframe): Keyframe[] {
        const others = this.frames.active.filter((other) => other !== frame);
        const limit = Math.max(1, Math.round(this.params.global.candidateNeighbours));
        if (others.length <= limit) return others;
        const chosen = this.frames.nearest(frame.rotation, limit, others);
        const newest = others[others.length - 1];
        if (!chosen.includes(newest)) chosen[chosen.length - 1] = newest;
        return chosen;
    }

    private bundleFreeIds(frame: Keyframe): number[] {
        const window = Math.max(0, Math.round(this.params.global.bundleWindow));
        const ids = window === 0 ? [frame.id] : this.frames.active.slice(-window).map((f) => f.id);
        if (!ids.includes(frame.id)) ids.push(frame.id);
        return ids;
    }

    private reject(frame: Keyframe, report: FrameReport, reason: string): void {
        frame.reject();
        report.accepted = false;
        report.reason = reason;
    }

    private emptyReport(frame: Keyframe, timings: StageTimings): FrameReport {
        return {
            id: frame.id,
            label: frame.label,
            accepted: true,
            reason: '',
            keypoints: frame.keypoints.length,
            focal: this.cameras.focal ?? 0,
            yaw: 0,
            pitch: 0,
            pairs: [],
            bundleBefore: 0,
            bundleAfter: 0,
            overlapPixels: 0,
            inconsistentPixels: 0,
            coveragePercent: 0,
            timings,
        };
    }

    private connection(query: Keyframe, candidate: Candidate): ConnectionPayload | null {
        const train = candidate.frame;
        if (!query.work || !train.work) return null;
        return {
            queryLabel: query.label,
            trainLabel: train.label,
            width: query.work.width,
            height: query.work.height,
            queryImage: query.work.data.buffer.slice(0),
            trainImage: train.work.data.buffer.slice(0),
            queryKeypoints: query.keypoints.map((keypoint) => ({ ...keypoint })),
            trainKeypoints: train.keypoints.map((keypoint) => ({ ...keypoint })),
            matches: candidate.matches,
            report: candidate.report,
        };
    }
}
