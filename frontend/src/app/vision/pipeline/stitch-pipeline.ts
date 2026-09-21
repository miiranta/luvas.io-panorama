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
import { ColorImage } from '../foundation/imaging/image';
import { Mat3, mat3Identity } from '../foundation/math/matrix3';
import { rotationDegreesBetween } from '../foundation/math/rotation';
import { AcceleratorSuite } from '../foundation/gpu/accelerator-suite';
import { CameraSolver } from './camera-solver';
import { FeatureExtractor } from './feature-extractor';
import { Keyframe } from './keyframe';
import { KeyframeStore } from './keyframe-store';
import { LinkRegistry } from './link-registry';
import { LiveTracker } from './live-tracker';
import { MosaicCompositor, ProgressReporter } from './mosaic-compositor';
import { ExportedImage } from '../compositing/export/panorama-exporter';
import { PairLink } from './pair-link';
import { PairLinker, isFitted } from './pair-linker';

const PAYLOAD_MARGIN = 4;
const RELINK_DISTORTION = 0.01;
const INTRUDER_REASON = 'not enough overlap with neighboring cameras (intruder image)';
const PARALLAX_PIXELS_PER_WIDTH = 2 / 640;
const PARALLAX_WARNING =
    'parallax detected — rotate the phone around its camera, not around your body';

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
    private globalBundlePending = false;
    private linkedDistortion = 0;
    private reporter: ProgressReporter = () => undefined;
    private readonly frames = new KeyframeStore();
    private readonly links = new LinkRegistry();
    private readonly accelerators = new AcceleratorSuite(() => this.params);
    private readonly cameras = new CameraSolver(() => this.params.global);
    private readonly linker = new PairLinker(
        () => this.params,
        () => this.accelerators.matcher(),
        () => ({
            focal: (frame) => this.cameras.focalFor(frame),
            distortion: this.cameras.distortion,
        }),
    );
    private readonly features = new FeatureExtractor(
        () => this.params,
        () => this.accelerators.detector(),
    );
    private readonly compositor = new MosaicCompositor(
        () => this.params,
        () => this.accelerators.blur(),
        () => this.accelerators.warper(),
        this.frames,
        this.links,
        this.cameras,
        (stage, progress) => this.reporter(stage, progress),
        (width, height, bands, view) => this.accelerators.mosaics()(width, height, bands, view),
    );
    private readonly tracker = new LiveTracker(this.frames, this.features, this.linker);

    setParams(params: PipelineParams): void {
        this.params = params;
    }

    warmup(): void {
        this.accelerators.warmup();
    }

    setReporter(reporter: ProgressReporter): void {
        this.reporter = reporter;
    }

    get frameCount(): number {
        return this.frames.active.length;
    }

    reset(): void {
        this.globalBundlePending = false;
        this.linkedDistortion = 0;
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

    needsSettle(): boolean {
        return (
            this.compositor.needsSettle() || this.globalBundlePending || this.distortionDrifted()
        );
    }

    async settle(): Promise<boolean> {
        const global = this.frameCount > 2;
        if (this.globalBundlePending) {
            if (global) this.adjustAll();
            this.globalBundlePending = false;
        }
        if (this.distortionDrifted()) {
            this.relink();
            if (global) this.adjustAll();
        }
        if (!this.compositor.needsSettle()) return false;
        await this.compositor.recompose();
        return true;
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
            this.cameras.initialize(frame);
            report.focal = this.cameras.focal ?? 0;
            const composing = performance.now();
            await this.compositor.recompose();
            timings.compose = performance.now() - composing;
            return finish(null);
        }

        this.frames.add(frame);
        const matching = performance.now();
        const { best, closest, links } = this.linkToNeighbors(frame, report);
        timings.match = performance.now() - matching;

        if (!best) {
            const connection = closest ? this.connection(frame, closest) : null;
            this.reject(frame, report, INTRUDER_REASON, true);
            return finish(connection);
        }

        const modelling = performance.now();
        const parent = best.candidate.frame;
        this.cameras.blendFocals(links, frame);
        frame.rotation = this.cameras.placeRelativeTo(frame, parent, best.link);
        timings.model = performance.now() - modelling;
        const connection = this.connection(frame, best.candidate);

        const angle = rotationDegreesBetween(frame.rotation, parent.rotation);
        const minAngle = this.params.global.keyframeMinAngle;
        if (minAngle > 0 && angle < minAngle && this.frameCount > 1) {
            this.reject(
                frame,
                report,
                `only ${angle.toFixed(1)}° of new coverage (below the keyframe threshold)`,
            );
            return finish(connection);
        }

        this.links.add(...links);
        this.globalBundlePending = true;
        const adjusting = performance.now();
        const bundle = this.cameras.adjust(
            this.frames.active,
            this.links,
            this.bundleFreeIds(frame),
        );
        const residualError = bundle.frameErrors.get(frame.id) ?? 0;
        timings.bundle = performance.now() - adjusting;

        const composing = performance.now();
        await this.compositor.integrate();
        timings.compose = performance.now() - composing;

        Object.assign(report, {
            focal: this.cameras.focal ?? 0,
            reprojectionError: bundle.error,
            residualError,
            warning:
                residualError > PARALLAX_PIXELS_PER_WIDTH * frame.workWidth ? PARALLAX_WARNING : '',
        });
        const stats = this.compositor.statsFor(frame.id);
        if (stats) {
            report.overlapPixels = stats.overlapPixels;
            report.inconsistentPixels = stats.inconsistentPixels;
        }
        return finish(connection);
    }

    async resolveFromScratch(): Promise<void> {
        this.linkedDistortion = this.cameras.distortion;
        const all = this.frames.all.filter((frame) => frame.hasComposeSource);
        for (const frame of all) frame.rejected = false;
        const links: PairLink[] = [];
        for (let i = 0; i < all.length; i++) {
            for (let j = i + 1; j < all.length; j++) {
                const link = this.relinkPair(all[i], all[j]);
                if (link) links.push(link);
            }
        }
        this.links.replace(links);
        if (all.length > 0) this.cameras.restartFocal(links, all[0]);

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
            const parentIndex = graph.strongestPlacedNeighbor(index, placed);
            if (parentIndex < 0) continue;
            const parent = all[parentIndex];
            const link = this.links.between(frame.id, parent.id);
            if (!link) continue;
            frame.rotation = this.cameras.placeRelativeTo(frame, parent, link);
            placed.add(index);
        }
        this.adjustAll();
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
            dropped: this.frames.all.length - this.frameCount,
            focal: this.cameras.focal ?? 0,
            distortion: this.cameras.distortion,
            vignetting: this.compositor.vignetting,
            frames: this.frameCount,
            surface: this.compositor.geometry?.surface ?? 'planar',
        };
    }

    async exportImage(tileSize?: number): Promise<ExportedImage | null> {
        return this.compositor.renderExport(
            this.params.compose.exportScale,
            this.params.compose.exportMegapixels,
            tileSize,
        );
    }

    private linkToNeighbors(
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
        for (const neighbor of this.neighbors(frame)) {
            const pair = this.linker.match(frame, neighbor);
            const link = isFitted(pair) ? this.linker.link(frame, neighbor, pair) : null;
            const pairReport = this.linker.report(pair, link);
            const candidate = { frame: neighbor, matches: pair.matches, report: pairReport };
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

    private neighbors(frame: Keyframe): Keyframe[] {
        const others = this.frames.active.filter((other) => other !== frame);
        const limit = Math.max(1, Math.round(this.params.global.candidateNeighbors));
        if (others.length <= limit) return others;
        const chosen = this.frames.nearest(frame.rotation, limit, others);
        const newest = others[others.length - 1];
        if (!chosen.includes(newest)) chosen[chosen.length - 1] = newest;
        return chosen;
    }

    private adjustAll(): void {
        const active = this.frames.active;
        this.cameras.adjust(
            active,
            this.links,
            active.map((frame) => frame.id),
        );
    }

    private distortionDrifted(): boolean {
        return Math.abs(this.cameras.distortion - this.linkedDistortion) > RELINK_DISTORTION;
    }

    private relink(): void {
        this.linkedDistortion = this.cameras.distortion;
        const active = new Map(this.frames.active.map((frame) => [frame.id, frame]));
        const links: PairLink[] = [];
        for (const previous of this.links.all) {
            const a = active.get(previous.a);
            const b = active.get(previous.b);
            if (!a || !b) continue;
            const link = this.relinkPair(a, b);
            if (link) links.push(link);
        }
        this.links.replace(links);
    }

    private relinkPair(a: Keyframe, b: Keyframe): PairLink | null {
        const pair = this.linker.match(a, b);
        if (!isFitted(pair)) return null;
        const link = this.linker.link(a, b, pair);
        return link.inliers > 0 ? this.inheritIntensities(link) : null;
    }

    private inheritIntensities(link: PairLink): PairLink {
        if (link.intensities.length > 0) return link;
        const previous = this.links.between(link.a, link.b);
        if (!previous || previous.intensities.length === 0) return link;
        if (previous.a === link.a) return { ...link, intensities: previous.intensities };
        return {
            ...link,
            intensities: previous.intensities.map((sample) => ({
                ax: sample.bx,
                ay: sample.by,
                colorA: sample.colorB,
                bx: sample.ax,
                by: sample.ay,
                colorB: sample.colorA,
            })),
        };
    }

    private bundleFreeIds(frame: Keyframe): number[] {
        const window = Math.max(0, Math.round(this.params.global.bundleWindow));
        const ids = window === 0 ? [frame.id] : this.frames.active.slice(-window).map((f) => f.id);
        if (!ids.includes(frame.id)) ids.push(frame.id);
        return ids;
    }

    private reject(frame: Keyframe, report: FrameReport, reason: string, keepSource = false): void {
        frame.reject(keepSource);
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
            pairs: [],
            reprojectionError: 0,
            residualError: 0,
            warning: '',
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
            trainWidth: train.work.width,
            trainHeight: train.work.height,
            queryImage: query.work.data.buffer.slice(0),
            trainImage: train.work.data.buffer.slice(0),
            queryKeypoints: query.keypoints.map((keypoint) => ({ ...keypoint })),
            trainKeypoints: train.keypoints.map((keypoint) => ({ ...keypoint })),
            matches: candidate.matches,
            report: candidate.report,
        };
    }
}
