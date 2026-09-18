import { PipelineParams } from '../../core/models/params';
import { BlurBackend } from '../acceleration/blur-backend';
import { WarpBackend } from '../acceleration/warp-backend';
import {
    CanvasBox,
    CanvasGeometry,
    alignDown,
    alignUp,
    angularSpan,
    createCanvasGeometry,
    unionFootprints,
} from '../compositing/canvas-geometry';
import { ExposureCompensator } from '../compositing/exposure';
import { levelHorizon } from '../compositing/horizon';
import { Mosaic } from '../compositing/mosaic';
import { VignettingSample, estimateVignetting, vignetteAt } from '../compositing/vignetting';
import { ColorImage } from '../imaging/image';
import { SeamFinder, SeamStats } from '../compositing/seam-finder';
import { Warper } from '../compositing/warper';
import { Mat3 } from '../math/matrix3';
import { rotationAngleBetween } from '../math/so3';
import { CameraSolver } from './camera-solver';
import { Keyframe } from './keyframe';
import { KeyframeStore } from './keyframe-store';
import { LinkRegistry } from './link-registry';
import { PairLink } from './pair-link';

const STABLE_DEGREES = 0.2;
const PREVIEW_TWIST_DEGREES = 0.15;
const FOCAL_TOLERANCE = 5e-3;
const GAIN_TOLERANCE = 0.02;
const PLACEMENT_DEGREES = 0.08;
const PREVIEW_LIVE_FRAMES = 3;
const DISTORTION_TOLERANCE = 2e-3;
const VIGNETTING_TOLERANCE = 0.01;
const FALLBACK_WIDTH = 640;
const FALLBACK_HEIGHT = 480;
const NO_STATS: SeamStats = { overlapPixels: 0, inconsistentPixels: 0 };
const EXPORT_MARGIN = 2;

export interface RasterImage {
    width: number;
    height: number;
    pixels: ArrayBuffer;
}

export type ProgressReporter = (stage: string, progress: number) => void;

export class MosaicCompositor {
    private committed: Mosaic | null = null;
    private preview: Mosaic | null = null;
    private canvas: CanvasGeometry | null = null;
    private committedGeometry: CanvasGeometry | null = null;
    private committedDistortion = 0;
    private committedVignetting = 0;
    private vignettingEstimate = 0;
    private readonly committedGains = new Map<number, number>();
    private readonly committedPlacements = new Map<number, { rotation: Mat3; focal: number }>();
    private readonly stats = new Map<number, SeamStats>();
    private readonly exposure = new ExposureCompensator();

    constructor(
        private readonly params: () => PipelineParams,
        private readonly blur: () => BlurBackend,
        private readonly warpBackend: () => WarpBackend,
        private readonly frames: KeyframeStore,
        private readonly links: LinkRegistry,
        private readonly cameras: CameraSolver,
        private readonly report: ProgressReporter = () => undefined,
    ) {}

    get isEmpty(): boolean {
        return this.committed === null;
    }

    get geometry(): CanvasGeometry | null {
        return this.canvas;
    }

    get vignetting(): number {
        return this.params().compose.vignetting ? this.vignettingEstimate : 0;
    }

    statsFor(id: number): SeamStats | undefined {
        return this.stats.get(id);
    }

    reset(): void {
        this.committed = null;
        this.preview = null;
        this.canvas = null;
        this.committedGeometry = null;
        this.vignettingEstimate = 0;
        this.committedGains.clear();
        this.committedPlacements.clear();
        this.stats.clear();
    }

    async recompose(): Promise<void> {
        const geometry = this.prepareCanvas();
        const mosaic = new Mosaic(geometry.width, geometry.height, this.params().compose.bands);
        const live = new Set(this.liveIds());
        this.stats.clear();
        for (const frame of this.frames.all) frame.uncommit();
        const pending = this.orderedFrames().filter((frame) => !live.has(frame.id));
        let done = 0;
        for (const frame of pending) {
            this.report('compositing mosaic', done / Math.max(1, pending.length));
            await this.commit(frame, geometry, mosaic);
            done++;
        }
        this.preview = null;
        this.committed = mosaic;
        this.rememberCommitted(geometry);
        await this.rebuildPreview(geometry);
    }

    async integrate(): Promise<void> {
        if (!this.committed) {
            await this.recompose();
            return;
        }
        const geometry = this.prepareCanvas();
        if (this.reshaped(geometry)) {
            await this.recompose();
            return;
        }
        const live = new Set(this.liveIds());
        for (const frame of this.orderedFrames()) {
            if (frame.committed || live.has(frame.id)) continue;
            await this.commit(frame, geometry, this.committed);
        }
        this.rememberCommitted(geometry);
        await this.rebuildPreview(geometry);
    }

    coveragePercent(): number {
        const mosaic = this.committed;
        const box = mosaic?.boundingBox(this.preview);
        if (!mosaic || !box) return 0;
        let covered = 0;
        let total = 0;
        for (let v = box.v0; v <= box.v1; v++) {
            for (let u = box.u0; u <= box.u1; u++) {
                const index = v * mosaic.width + u;
                total++;
                if (mosaic.coverage[index] || this.preview?.coverage[index]) covered++;
            }
        }
        return total === 0 ? 0 : (covered / total) * 100;
    }

    span(): { horizontal: number; vertical: number } {
        const box = this.committed?.boundingBox(this.preview);
        if (!box || !this.canvas) return { horizontal: 0, vertical: 0 };
        return angularSpan(this.canvas, box);
    }

    render(crop: boolean, margin = 0): RasterImage | null {
        if (!this.committed) return null;
        const useBands = this.params().compose.blend === 'multiband';
        const box = crop ? this.committed.boundingBox(this.preview) : null;
        const region = box
            ? {
                  u0: Math.max(0, box.u0 - margin),
                  v0: Math.max(0, box.v0 - margin),
                  u1: Math.min(this.committed.width - 1, box.u1 + margin),
                  v1: Math.min(this.committed.height - 1, box.v1 + margin),
              }
            : null;
        const image = this.committed.render(useBands, this.preview, region);
        return { width: image.width, height: image.height, pixels: image.data.buffer };
    }

    async renderExport(scale: number, megapixelBudget: number): Promise<RasterImage | null> {
        const frames = this.orderedFrames();
        if (frames.length === 0) return null;
        this.report('preparing export', 0);
        const sources = new Map<number, ColorImage>();
        for (const frame of frames) {
            const source = await frame.composeImage();
            if (source) sources.set(frame.id, source);
        }
        if (sources.size === 0) return null;
        const params = this.params();
        const reference = frames.find((frame) => sources.has(frame.id)) as Keyframe;
        const referenceSource = sources.get(reference.id) as ColorImage;
        const nativeFocal =
            this.cameras.focalFor(reference) * (referenceSource.width / reference.workWidth);
        const orientation =
            this.canvas?.orientation ?? createCanvasGeometry('planar', 16, 1).orientation;
        let geometry = this.exportGeometry(
            params.compose.surface,
            nativeFocal * scale,
            orientation,
        );
        let box = this.exportBox(geometry, frames, sources);
        if (!box) return null;
        const megapixels = ((box.u1 - box.u0 + 1) * (box.v1 - box.v0 + 1)) / 1e6;
        if (megapixels > megapixelBudget) {
            const shrink = Math.sqrt(megapixelBudget / megapixels);
            geometry = this.exportGeometry(
                params.compose.surface,
                nativeFocal * scale * shrink,
                orientation,
            );
            box = this.exportBox(geometry, frames, sources);
            if (!box) return null;
        }
        const width = box.u1 - box.u0 + 1;
        const height = box.v1 - box.v0 + 1;
        const mosaic = new Mosaic(width, height, params.compose.bands, {
            u0: ((box.u0 % geometry.width) + geometry.width) % geometry.width,
            v0: box.v0,
            canvasWidth: geometry.width,
        });
        let done = 0;
        for (const frame of frames) {
            const source = sources.get(frame.id);
            if (source) {
                this.report('rendering export', done / frames.length);
                await this.drawSource(frame, source, geometry, mosaic, null);
            }
            done++;
        }
        this.report('rendering export', 1);
        const image = mosaic.render(params.compose.blend === 'multiband', null);
        return { width: image.width, height: image.height, pixels: image.data.buffer };
    }

    private exportGeometry(
        surface: PipelineParams['compose']['surface'],
        focal: number,
        orientation: CanvasGeometry['orientation'],
    ): CanvasGeometry {
        const width =
            surface === 'planar'
                ? Math.round(focal * 2.4)
                : Math.round(Math.PI * 2 * Math.max(1, focal));
        return createCanvasGeometry(surface, Math.max(64, width), focal, orientation);
    }

    private exportBox(
        geometry: CanvasGeometry,
        frames: readonly Keyframe[],
        sources: ReadonlyMap<number, ColorImage>,
    ): CanvasBox | null {
        const requests = frames.flatMap((frame) => {
            const source = sources.get(frame.id);
            if (!source) return [];
            return [
                {
                    rotation: frame.rotation,
                    width: source.width,
                    height: source.height,
                    focal: this.cameras.focalFor(frame) * (source.width / frame.workWidth),
                    distortion: this.cameras.distortion,
                },
            ];
        });
        const box = unionFootprints(geometry, requests);
        if (!box) return null;
        const u0 = alignDown(box.u0 - EXPORT_MARGIN);
        const v0 = Math.max(0, alignDown(box.v0 - EXPORT_MARGIN));
        return {
            u0,
            v0,
            u1: alignUp(box.u1 + EXPORT_MARGIN + 1) - 1,
            v1: Math.min(geometry.height - 1, alignUp(box.v1 + EXPORT_MARGIN + 1) - 1),
        };
    }

    private prepareCanvas(): CanvasGeometry {
        const params = this.params();
        const active = this.frames.active;
        const reference = active[0] ?? { workWidth: FALLBACK_WIDTH, workHeight: FALLBACK_HEIGHT };
        this.canvas = createCanvasGeometry(
            params.compose.surface,
            Math.round(params.compose.canvasWidth),
            this.cameras.focalFor(reference),
            levelHorizon(active.map((frame) => frame.rotation)),
        );
        this.balanceExposure(active);
        return this.canvas;
    }

    private reshaped(geometry: CanvasGeometry): boolean {
        const previous = this.committedGeometry;
        if (!previous) return true;
        return (
            previous.surface !== geometry.surface ||
            previous.width !== geometry.width ||
            previous.height !== geometry.height
        );
    }

    needsSettle(): boolean {
        const geometry = this.canvas;
        const previous = this.committedGeometry;
        if (!this.committed || !geometry || !previous) return false;
        if (this.reshaped(geometry)) return true;
        if (Math.abs(geometry.focal / previous.focal - 1) > FOCAL_TOLERANCE) return true;
        if (Math.abs(this.cameras.distortion - this.committedDistortion) > DISTORTION_TOLERANCE) {
            return true;
        }
        if (Math.abs(this.vignetting - this.committedVignetting) > VIGNETTING_TOLERANCE)
            return true;
        const twist =
            (rotationAngleBetween(geometry.orientation, previous.orientation) * 180) / Math.PI;
        if (twist > PREVIEW_TWIST_DEGREES) return true;
        for (const frame of this.frames.active) {
            const gain = this.committedGains.get(frame.id);
            if (gain !== undefined && Math.abs(gain - frame.gain) > GAIN_TOLERANCE) return true;
            const placement = this.committedPlacements.get(frame.id);
            if (!placement) continue;
            const moved =
                (rotationAngleBetween(frame.rotation, placement.rotation) * 180) / Math.PI;
            if (moved > PLACEMENT_DEGREES) return true;
            const focal = this.cameras.focalFor(frame);
            if (Math.abs(focal / placement.focal - 1) > FOCAL_TOLERANCE) return true;
        }
        return false;
    }

    private rememberCommitted(geometry: CanvasGeometry): void {
        this.committedGeometry = geometry;
        this.committedDistortion = this.cameras.distortion;
        this.committedVignetting = this.vignetting;
        this.committedGains.clear();
        this.committedPlacements.clear();
        for (const frame of this.frames.active) {
            if (!frame.committed) continue;
            this.committedGains.set(frame.id, frame.gain);
            this.committedPlacements.set(frame.id, {
                rotation: Float64Array.from(frame.rotation) as Mat3,
                focal: this.cameras.focalFor(frame),
            });
        }
    }

    private radiusSquared(frame: Keyframe, x: number, y: number): number {
        const focal = this.cameras.focalFor(frame);
        const dx = (x - frame.centreX) / focal;
        const dy = (y - frame.centreY) / focal;
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

    private balanceExposure(active: Keyframe[]): void {
        const indexOf = new Map(active.map((frame, index) => [frame.id, index]));
        this.estimateVignetting(active, indexOf);
        if (!this.params().compose.exposureCompensation || active.length === 0) {
            for (const frame of this.frames.all) frame.gain = 1;
            return;
        }
        const pairs = this.links.verified.flatMap((link) => {
            const a = indexOf.get(link.a);
            const b = indexOf.get(link.b);
            if (a === undefined || b === undefined) return [];
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

    private liveIds(): number[] {
        const configured = Math.max(1, Math.round(this.params().global.bundleWindow) || 1);
        const window = Math.min(configured, PREVIEW_LIVE_FRAMES);
        const recent = this.frames.active.slice(-window);
        const live = recent.filter(
            (frame) =>
                !frame.composedRotation ||
                (rotationAngleBetween(frame.rotation, frame.composedRotation) * 180) / Math.PI >
                    STABLE_DEGREES,
        );
        const newest = recent.at(-1);
        if (newest && !live.includes(newest)) live.push(newest);
        return live.map((frame) => frame.id);
    }

    private orderedFrames(): Keyframe[] {
        return this.links
            .compositionOrder(this.frames.all)
            .map((id) => this.frames.byId(id))
            .filter((frame): frame is Keyframe => frame !== undefined && !frame.rejected);
    }

    private async rebuildPreview(geometry: CanvasGeometry): Promise<void> {
        const live = new Set(this.liveIds());
        const bands = this.params().compose.bands;
        const reusable =
            this.preview?.width === geometry.width &&
            this.preview.height === geometry.height &&
            this.preview.bands === bands;
        const preview = reusable
            ? (this.preview as Mosaic)
            : new Mosaic(geometry.width, geometry.height, bands);
        preview.reset();
        for (const frame of this.orderedFrames()) {
            if (!live.has(frame.id)) continue;
            this.stats.set(frame.id, await this.draw(frame, geometry, preview, this.committed));
        }
        this.preview = preview;
    }

    private async commit(frame: Keyframe, geometry: CanvasGeometry, mosaic: Mosaic): Promise<void> {
        this.stats.set(frame.id, await this.draw(frame, geometry, mosaic, null));
        frame.commit();
    }

    private async draw(
        frame: Keyframe,
        geometry: CanvasGeometry,
        mosaic: Mosaic,
        reference: Mosaic | null,
    ): Promise<SeamStats> {
        const source = await frame.composeImage();
        if (!source) return NO_STATS;
        return this.drawSource(frame, source, geometry, mosaic, reference);
    }

    private async drawSource(
        frame: Keyframe,
        source: ColorImage,
        geometry: CanvasGeometry,
        mosaic: Mosaic,
        reference: Mosaic | null,
    ): Promise<SeamStats> {
        const params = this.params().compose;
        const focal = this.cameras.focalFor(frame) * (source.width / frame.workWidth);
        const tile = new Warper(geometry, params, this.warpBackend()).warp(
            frame.rotation,
            source,
            focal,
            frame.gain,
            this.cameras.distortion,
            this.vignetting,
        );
        if (!tile) return NO_STATS;
        const stats = new SeamFinder(params).cut(mosaic, tile, reference);
        if (params.blend === 'multiband') {
            mosaic.addPyramidBands(tile, this.blur());
            return stats;
        }
        if (params.blend === 'average') {
            for (let i = 0; i < tile.mask.length; i++) tile.mask[i] = tile.mask[i] > 0 ? 1 : 0;
        }
        mosaic.addFlat(tile);
        return stats;
    }
}
