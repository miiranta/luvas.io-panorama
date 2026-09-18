import { PipelineParams } from '../../core/models/params';
import { BlurBackend } from '../acceleration/blur-backend';
import { CanvasGeometry, angularSpan, createCanvasGeometry } from '../compositing/canvas-geometry';
import { ExposureCompensator } from '../compositing/exposure';
import { levelHorizon } from '../compositing/horizon';
import { Mosaic } from '../compositing/mosaic';
import { SeamFinder, SeamStats } from '../compositing/seam-finder';
import { Warper } from '../compositing/warper';
import { rotationAngleBetween } from '../math/so3';
import { CameraSolver } from './camera-solver';
import { Keyframe } from './keyframe';
import { KeyframeStore } from './keyframe-store';
import { LinkRegistry } from './link-registry';

const STABLE_DEGREES = 0.02;
const FALLBACK_WIDTH = 640;
const FALLBACK_HEIGHT = 480;
const NO_STATS: SeamStats = { overlapPixels: 0, inconsistentPixels: 0 };

export interface RasterImage {
    width: number;
    height: number;
    pixels: ArrayBuffer;
}

export class MosaicCompositor {
    private committed: Mosaic | null = null;
    private preview: Mosaic | null = null;
    private canvas: CanvasGeometry | null = null;
    private readonly stats = new Map<number, SeamStats>();
    private readonly exposure = new ExposureCompensator();

    constructor(
        private readonly params: () => PipelineParams,
        private readonly blur: () => BlurBackend,
        private readonly frames: KeyframeStore,
        private readonly links: LinkRegistry,
        private readonly cameras: CameraSolver,
    ) {}

    get isEmpty(): boolean {
        return this.committed === null;
    }

    statsFor(id: number): SeamStats | undefined {
        return this.stats.get(id);
    }

    reset(): void {
        this.committed = null;
        this.preview = null;
        this.canvas = null;
        this.stats.clear();
    }

    async recompose(): Promise<void> {
        const geometry = this.prepareCanvas();
        const mosaic = new Mosaic(geometry.width, geometry.height, this.params().compose.bands);
        const live = new Set(this.liveIds());
        this.stats.clear();
        for (const frame of this.frames.all) frame.uncommit();
        for (const frame of this.orderedFrames()) {
            if (live.has(frame.id)) continue;
            await this.commit(frame, geometry, mosaic);
        }
        this.preview = null;
        this.committed = mosaic;
        await this.rebuildPreview(geometry);
    }

    async integrate(): Promise<void> {
        if (!this.committed) {
            await this.recompose();
            return;
        }
        const geometry = this.prepareCanvas();
        const live = new Set(this.liveIds());
        for (const frame of this.orderedFrames()) {
            if (frame.committed || live.has(frame.id)) continue;
            await this.commit(frame, geometry, this.committed);
        }
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
        const image = this.committed.render(useBands, this.preview);
        const whole = { width: image.width, height: image.height, pixels: image.data.buffer };
        const box = crop ? this.committed.boundingBox(this.preview) : null;
        if (!box) return whole;
        const u0 = Math.max(0, box.u0 - margin);
        const v0 = Math.max(0, box.v0 - margin);
        const width = Math.min(image.width - 1, box.u1 + margin) - u0 + 1;
        const height = Math.min(image.height - 1, box.v1 + margin) - v0 + 1;
        if (width <= 0 || height <= 0) return whole;
        const out = new Uint8ClampedArray(width * height * 4);
        for (let y = 0; y < height; y++) {
            const start = ((v0 + y) * image.width + u0) * 4;
            out.set(image.data.subarray(start, start + width * 4), y * width * 4);
        }
        return { width, height, pixels: out.buffer };
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

    private balanceExposure(active: Keyframe[]): void {
        if (!this.params().compose.exposureCompensation || active.length === 0) {
            for (const frame of this.frames.all) frame.gain = 1;
            return;
        }
        const indexOf = new Map(active.map((frame, index) => [frame.id, index]));
        const pairs = this.links.verified.flatMap((link) => {
            const a = indexOf.get(link.a);
            const b = indexOf.get(link.b);
            if (a === undefined || b === undefined) return [];
            return [
                {
                    a,
                    b,
                    meanA: Math.max(1, link.meanIntensityA),
                    meanB: Math.max(1, link.meanIntensityB),
                    weight: link.inliers,
                },
            ];
        });
        const gains = this.exposure.solve(pairs, active.length);
        active.forEach((frame, index) => {
            frame.gain = gains[index];
        });
    }

    private liveIds(): number[] {
        const window = Math.max(1, Math.round(this.params().global.bundleWindow) || 1);
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
        const params = this.params().compose;
        const source = await frame.composeImage();
        if (!source) return NO_STATS;
        const focal = this.cameras.focalFor(frame) * (source.width / frame.workWidth);
        const tile = new Warper(geometry, params).warp(frame.rotation, source, focal, frame.gain);
        if (!tile) return NO_STATS;
        const stats = new SeamFinder(params).cut(mosaic, tile, reference);
        if (params.blend === 'multiband') {
            mosaic.addBands(tile, Math.max(1, params.featherWidth / 8), this.blur());
            return stats;
        }
        if (params.blend === 'average') {
            for (let i = 0; i < tile.mask.length; i++) tile.mask[i] = tile.mask[i] > 0 ? 1 : 0;
        }
        mosaic.addFlat(tile);
        return stats;
    }
}
