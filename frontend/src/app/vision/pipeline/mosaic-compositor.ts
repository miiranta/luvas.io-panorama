import { PipelineParams } from '../../core/models/params';
import { RasterPayload } from '../../core/models/worker-protocol';
import { BlurBackend } from '../compositing/blending/blur-backend';
import { WarpBackend } from '../compositing/warping/warp-backend';
import {
    CanvasGeometry,
    angularSpan,
    createCanvasGeometry,
} from '../compositing/warping/canvas-geometry';
import { levelHorizon } from '../registration/alignment/level-horizon';
import { chooseSurface } from '../compositing/warping/choose-surface';
import { CpuMosaic } from '../compositing/blending/cpu-mosaic';
import { MosaicFactory, MosaicSurface } from '../compositing/blending/mosaic-surface';
import { ColorImage, Rgb } from '../foundation/imaging/image';
import { SeamFinder, SeamStats } from '../compositing/seams/seam-finder';
import { Warper } from '../compositing/warping/warper';
import { WarpTile } from '../compositing/warping/warp-tile';
import { CanvasBox } from '../compositing/warping/canvas-box';
import { blendTile, compositeMode } from '../compositing/blending/blend-tile';
import { Mat3 } from '../foundation/math/matrix3';
import { rotationDegreesBetween } from '../foundation/math/rotation';
import { CameraSolver } from './camera-solver';
import { Keyframe } from './keyframe';
import { KeyframeStore } from './keyframe-store';
import { LinkRegistry } from './link-registry';
import {
    EXPORT_TILE,
    ExportedImage,
    PanoramaExporter,
} from '../compositing/export/panorama-exporter';
import { PhotometricCalibrator } from './photometric-calibrator';
import { GainGrid, gainGridsDiffer } from '../compositing/photometric/gain-grid';

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

export type ProgressReporter = (stage: string, progress: number) => void;

function gainChange(before: Rgb, after: Rgb): number {
    return Math.max(
        Math.abs(before[0] - after[0]),
        Math.abs(before[1] - after[1]),
        Math.abs(before[2] - after[2]),
    );
}

export class MosaicCompositor {
    private committed: MosaicSurface | null = null;
    private preview: MosaicSurface | null = null;
    private canvas: CanvasGeometry | null = null;
    private committedGeometry: CanvasGeometry | null = null;
    private committedDistortion = 0;
    private committedVignetting = 0;
    private readonly committedGains = new Map<number, Rgb>();
    private readonly committedGrids = new Map<number, GainGrid | null>();
    private readonly committedPlacements = new Map<number, { rotation: Mat3; focal: number }>();
    private readonly stats = new Map<number, SeamStats>();
    private coverage: number | null = null;
    private readonly photometry: PhotometricCalibrator;

    constructor(
        private readonly params: () => PipelineParams,
        private readonly blur: () => BlurBackend,
        private readonly warpBackend: () => WarpBackend,
        private readonly frames: KeyframeStore,
        private readonly links: LinkRegistry,
        private readonly cameras: CameraSolver,
        private readonly report: ProgressReporter = () => undefined,
        private readonly createMosaic: MosaicFactory = (width, height, bands, view) =>
            new CpuMosaic(width, height, bands, view),
    ) {
        this.photometry = new PhotometricCalibrator(params, frames, links, cameras);
    }

    get isEmpty(): boolean {
        return this.committed === null;
    }

    get geometry(): CanvasGeometry | null {
        return this.canvas;
    }

    get vignetting(): number {
        return this.photometry.vignetting;
    }

    statsFor(id: number): SeamStats | undefined {
        return this.stats.get(id);
    }

    reset(): void {
        this.committed?.dispose();
        this.preview?.dispose();
        this.committed = null;
        this.preview = null;
        this.canvas = null;
        this.committedGeometry = null;
        this.photometry.reset();
        this.committedGains.clear();
        this.committedGrids.clear();
        this.committedPlacements.clear();
        this.stats.clear();
        this.coverage = null;
    }

    async recompose(): Promise<void> {
        const geometry = this.prepareCanvas();
        const mosaic = this.surfaceFor(this.committed, geometry);
        const live = this.liveIds();
        const ordered = this.orderedFrames();
        this.stats.clear();
        for (const frame of this.frames.all) frame.uncommit();
        const pending = ordered.filter((frame) => !live.has(frame.id));
        let done = 0;
        for (const frame of pending) {
            this.report('compositing mosaic', done / Math.max(1, pending.length));
            await this.commit(frame, geometry, mosaic);
            done++;
        }
        if (this.committed !== mosaic) this.committed?.dispose();
        this.committed = mosaic;
        this.rememberCommitted(geometry);
        await this.rebuildPreview(geometry, ordered, live);
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
        const live = this.liveIds();
        const ordered = this.orderedFrames();
        for (const frame of ordered) {
            if (frame.committed || live.has(frame.id)) continue;
            await this.commit(frame, geometry, this.committed);
        }
        this.rememberCommitted(geometry);
        await this.rebuildPreview(geometry, ordered, live);
    }

    coveragePercent(): number {
        this.coverage ??= this.measureCoverage();
        return this.coverage;
    }

    private measureCoverage(): number {
        const mosaic = this.committed;
        const box = mosaic?.boundingBox(this.preview);
        if (!mosaic || !box) return 0;
        const total = (box.u1 - box.u0 + 1) * (box.v1 - box.v0 + 1);
        return total === 0 ? 0 : (mosaic.coveredCount(box, this.preview) / total) * 100;
    }

    span(): { horizontal: number; vertical: number } {
        const box = this.committed?.boundingBox(this.preview);
        if (!box || !this.canvas) return { horizontal: 0, vertical: 0 };
        return angularSpan(this.canvas, box);
    }

    render(crop: boolean, margin = 0): RasterPayload | null {
        if (!this.committed) return null;
        const compose = this.params().compose;
        const useBands = compose.blend === 'multiband';
        const box = crop ? this.committed.boundingBox(this.preview) : null;
        const region = box
            ? {
                  u0: Math.max(0, box.u0 - margin),
                  v0: Math.max(0, box.v0 - margin),
                  u1: Math.min(this.committed.width - 1, box.u1 + margin),
                  v1: Math.min(this.committed.height - 1, box.v1 + margin),
              }
            : null;
        const image = this.committed.render(useBands, this.preview, region, compositeMode(compose));
        return { width: image.width, height: image.height, pixels: image.data.buffer };
    }

    async renderExport(
        scale: number,
        megapixelCap: number,
        tileSize = EXPORT_TILE,
    ): Promise<ExportedImage | null> {
        const frames = this.orderedFrames();
        if (frames.length === 0) return null;
        this.prepareCanvas();
        const exporter = new PanoramaExporter({
            params: this.params,
            blur: this.blur,
            createMosaic: this.createMosaic,
            focalAt: (frame, width) => this.cameras.focalAt(frame, width),
            distortion: () => this.cameras.distortion,
            warpFrame: (geometry, frame, source, clip) =>
                this.warpFrame(geometry, frame, source, clip),
            orientation: () =>
                this.canvas?.orientation ?? createCanvasGeometry('planar', 64, 1).orientation,
            surface: () => this.canvas?.surface ?? 'planar',
            report: this.report,
        });
        return exporter.render(frames, scale, megapixelCap, tileSize);
    }

    private prepareCanvas(): CanvasGeometry {
        const params = this.params();
        const active = this.frames.active;
        const reference = active[0] ?? { workWidth: FALLBACK_WIDTH, workHeight: FALLBACK_HEIGHT };
        const orientation = levelHorizon(active.map((frame) => frame.rotation));
        const surface =
            params.compose.surface === 'auto'
                ? chooseSurface(
                      active.map((frame) => ({
                          rotation: frame.rotation,
                          width: frame.workWidth,
                          height: frame.workHeight,
                          focal: this.cameras.focalFor(frame),
                          distortion: this.cameras.distortion,
                      })),
                      orientation,
                  )
                : params.compose.surface;
        this.canvas = createCanvasGeometry(
            surface,
            Math.round(params.compose.canvasWidth),
            this.cameras.focalFor(reference),
            orientation,
        );
        this.photometry.calibrate(active);
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
        const twist = rotationDegreesBetween(geometry.orientation, previous.orientation);
        if (twist > PREVIEW_TWIST_DEGREES) return true;
        for (const frame of this.frames.active) {
            const gain = this.committedGains.get(frame.id);
            if (gain && gainChange(gain, frame.gain) > GAIN_TOLERANCE) return true;
            const grid = this.committedGrids.get(frame.id);
            if (grid !== undefined && gainGridsDiffer(grid, frame.gainGrid, GAIN_TOLERANCE)) {
                return true;
            }
            const placement = this.committedPlacements.get(frame.id);
            if (!placement) continue;
            const moved = rotationDegreesBetween(frame.rotation, placement.rotation);
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
        this.committedGrids.clear();
        this.committedPlacements.clear();
        for (const frame of this.frames.active) {
            if (!frame.committed) continue;
            this.committedGains.set(frame.id, frame.gain);
            this.committedGrids.set(frame.id, frame.gainGrid);
            this.committedPlacements.set(frame.id, {
                rotation: Float64Array.from(frame.rotation) as Mat3,
                focal: this.cameras.focalFor(frame),
            });
        }
    }

    private liveIds(): Set<number> {
        const configured = Math.max(1, Math.round(this.params().global.bundleWindow) || 1);
        const window = Math.min(configured, PREVIEW_LIVE_FRAMES);
        const recent = this.frames.active.slice(-window);
        const live = recent.filter(
            (frame) =>
                !frame.composedRotation ||
                rotationDegreesBetween(frame.rotation, frame.composedRotation) > STABLE_DEGREES,
        );
        const newest = recent.at(-1);
        if (newest && !live.includes(newest)) live.push(newest);
        return new Set(live.map((frame) => frame.id));
    }

    private orderedFrames(): Keyframe[] {
        return this.links.compositionOrder(this.frames.all);
    }

    private surfaceFor(existing: MosaicSurface | null, geometry: CanvasGeometry): MosaicSurface {
        const bands = this.params().compose.bands;
        if (
            existing &&
            existing.width === geometry.width &&
            existing.height === geometry.height &&
            existing.bands === bands
        ) {
            existing.reset();
            return existing;
        }
        return this.createMosaic(geometry.width, geometry.height, bands);
    }

    private async rebuildPreview(
        geometry: CanvasGeometry,
        ordered: readonly Keyframe[],
        live: ReadonlySet<number>,
    ): Promise<void> {
        const preview = this.surfaceFor(this.preview, geometry);
        if (this.preview !== preview) this.preview?.dispose();
        for (const frame of ordered) {
            if (!live.has(frame.id)) continue;
            this.stats.set(frame.id, await this.draw(frame, geometry, preview, this.committed));
        }
        this.preview = preview;
        this.coverage = null;
    }

    private async commit(
        frame: Keyframe,
        geometry: CanvasGeometry,
        mosaic: MosaicSurface,
    ): Promise<void> {
        this.stats.set(frame.id, await this.draw(frame, geometry, mosaic, null));
        frame.commit();
    }

    private warpFrame(
        geometry: CanvasGeometry,
        frame: Keyframe,
        source: ColorImage,
        clip: CanvasBox | null = null,
    ): WarpTile | null {
        return new Warper(geometry, this.params().compose, this.warpBackend()).warp(
            frame.rotation,
            source,
            this.cameras.focalAt(frame, source.width),
            frame.gain,
            frame.gainGrid,
            this.cameras.distortion,
            this.vignetting,
            clip,
        );
    }

    private async draw(
        frame: Keyframe,
        geometry: CanvasGeometry,
        mosaic: MosaicSurface,
        reference: MosaicSurface | null,
    ): Promise<SeamStats> {
        const source = await frame.composeImage();
        const tile = source ? this.warpFrame(geometry, frame, source) : null;
        if (!tile) return NO_STATS;
        const params = this.params().compose;
        const stats = new SeamFinder(params).cut(mosaic, tile, reference);
        blendTile(mosaic, tile, params.blend, this.blur(), compositeMode(params));
        return stats;
    }
}
