import { Injectable, computed, signal } from '@angular/core';
import { DEFAULT_PARAMS, ParamGroup, PipelineParams } from '../models/params';
import {
    ConnectionPayload,
    FrameReport,
    GraphPayload,
    MosaicPayload,
    PreviewPayload,
} from '../models/reports';
import { PipelineState, WorkerRequest, WorkerResponse } from '../models/worker-protocol';

@Injectable({ providedIn: 'root' })
export class StitcherService {
    private worker: Worker | null = null;
    private pendingExport: {
        resolve: (blob: Blob) => void;
        reject: (error: Error) => void;
    } | null = null;
    private captureIndex = 0;
    private previewFrame: number | null = null;
    private previewClock = -1;
    private previewCanvas: OffscreenCanvasRenderingContext2D | null = null;
    private previewInFlight = false;
    private previewSource: HTMLVideoElement | null = null;
    private epoch = 0;
    private sessionWorkWidth: number | null = null;

    readonly params = signal<PipelineParams>(structuredClone(DEFAULT_PARAMS));
    readonly reports = signal<FrameReport[]>([]);
    readonly connection = signal<ConnectionPayload | null>(null);
    readonly mosaic = signal<MosaicPayload | null>(null);
    readonly preview = signal<PreviewPayload | null>(null);
    readonly graph = signal<GraphPayload>({
        nodes: [],
        edges: [],
        order: [],
        reference: -1,
        components: 0,
    });
    readonly busy = signal(false);
    readonly ready = signal(false);
    readonly status = signal('waiting for camera');
    readonly error = signal<string | null>(null);
    readonly working = signal(false);
    readonly stale = signal(false);
    readonly progress = signal(-1);

    readonly acceptedFrames = computed(
        () => this.mosaic()?.frames ?? this.reports().filter((r) => r.accepted).length,
    );
    readonly rejectedFrames = computed(
        () => this.mosaic()?.dropped ?? this.reports().filter((r) => !r.accepted).length,
    );
    readonly lastReport = computed(() => this.reports().at(-1) ?? null);
    readonly lastAccepted = computed(
        () => [...this.reports()].reverse().find((report) => report.accepted) ?? null,
    );
    readonly composing = computed(() => this.working() || this.stale());
    readonly exportReady = computed(
        () => this.mosaic() !== null && !this.composing() && this.acceptedFrames() > 0,
    );

    start(): void {
        if (this.worker) return;
        this.worker = new Worker(new URL('../workers/stitch.worker', import.meta.url), {
            type: 'module',
        });
        this.worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) =>
            this.handle(event.data),
        );
        this.send({ kind: 'params', params: this.params() });
    }

    private send(request: WorkerRequest, transfer: Transferable[] = []): void {
        if (!this.worker) this.start();
        this.worker?.postMessage(request, transfer);
    }

    private handle(message: WorkerResponse): void {
        switch (message.kind) {
            case 'ready':
                this.ready.set(true);
                this.status.set('ready');
                break;
            case 'frame':
                this.reports.update((list) => [...list, message.report]);
                if (message.connection) this.connection.set(message.connection);
                this.status.set(
                    message.report.accepted
                        ? `frame ${message.report.label} merged`
                        : `frame ${message.report.label} discarded`,
                );
                this.busy.set(false);
                break;
            case 'mosaic':
                this.mosaic.set(message.mosaic);
                break;
            case 'graph':
                this.graph.set(message.graph);
                break;
            case 'preview': {
                if (message.epoch !== this.epoch) break;
                this.previewInFlight = false;
                this.preview.set(message.preview);
                this.tickPreview();
                break;
            }
            case 'state':
                this.applyState(message.state);
                break;
            case 'progress':
                this.status.set(message.detail);
                break;
            case 'export': {
                const blob = new Blob([message.png], { type: 'image/png' });
                this.pendingExport?.resolve(blob);
                this.pendingExport = null;
                this.busy.set(false);
                break;
            }
            case 'error':
                this.error.set(message.message);
                if (message.request === 'preview') {
                    this.previewInFlight = false;
                    break;
                }
                if (
                    !message.request ||
                    message.request === 'frame' ||
                    message.request === 'export'
                ) {
                    this.busy.set(false);
                }
                if (message.request === 'export') this.settleExport(new Error(message.message));
                break;
        }
    }

    private applyState(state: PipelineState): void {
        this.working.set(state.busy);
        this.stale.set(state.stale);
        this.progress.set(state.progress);
        if (state.busy) this.status.set(state.stage);
    }

    updateParam(group: ParamGroup, key: string, value: number | boolean | string): void {
        this.params.update((current) => {
            const next = structuredClone(current);
            (next[group] as unknown as Record<string, unknown>)[key] = value;
            return next;
        });
        this.send({ kind: 'params', params: this.params() });
    }

    resetParams(): void {
        this.params.set(structuredClone(DEFAULT_PARAMS));
        this.send({ kind: 'params', params: this.params() });
    }

    recompose(): void {
        if (this.reports().length === 0) return;
        this.status.set('recompositing mosaic');
        this.send({ kind: 'recompose' });
    }

    resolveFromScratch(): void {
        if (this.reports().length < 2) return;
        this.status.set('reordering from the graph');
        this.send({ kind: 'resolve' });
    }

    trackLive(source: HTMLVideoElement): void {
        this.previewSource = source;
        if (this.previewFrame !== null) return;
        const loop = () => {
            this.previewFrame = requestAnimationFrame(loop);
            this.tickPreview();
        };
        this.previewFrame = requestAnimationFrame(loop);
    }

    stopTracking(): void {
        if (this.previewFrame !== null) cancelAnimationFrame(this.previewFrame);
        this.previewFrame = null;
        this.previewClock = -1;
        this.previewSource = null;
        this.previewInFlight = false;
        this.preview.set(null);
    }

    private tickPreview(): void {
        const source = this.previewSource;
        if (!source || this.previewInFlight || this.busy() || this.working()) return;
        if (source.currentTime === this.previewClock) return;
        if (this.reports().every((report) => !report.accepted)) return;
        if (source.readyState < 2 || !source.videoWidth) return;
        const frame = this.rasterizePreview(source);
        if (!frame) return;
        this.previewClock = source.currentTime;
        this.previewInFlight = true;
        this.send(
            {
                kind: 'preview',
                epoch: this.epoch,
                work: {
                    width: frame.width,
                    height: frame.height,
                    pixels: frame.data.buffer as ArrayBuffer,
                },
            },
            [frame.data.buffer as ArrayBuffer],
        );
    }

    async capture(source: HTMLVideoElement): Promise<void> {
        this.busy.set(true);
        this.error.set(null);
        const params = this.params();
        const width = source.videoWidth;
        const height = source.videoHeight;
        if (!width || !height) {
            this.error.set('camera has no frame available');
            this.busy.set(false);
            return;
        }
        const snapshot = new OffscreenCanvas(width, height);
        const snapshotContext = snapshot.getContext('2d');
        if (!snapshotContext) {
            this.error.set('failed to freeze the camera frame');
            this.busy.set(false);
            return;
        }
        snapshotContext.drawImage(source, 0, 0);
        this.sessionWorkWidth ??= params.detect.workWidth;
        const work = this.rasterize(snapshot, width, height, this.workWidth());
        const compose = this.rasterize(snapshot, width, height, params.compose.composeWidth);
        if (!work || !compose) {
            this.error.set('failed to read the camera frame');
            this.busy.set(false);
            return;
        }
        this.captureIndex += 1;
        const label = `#${String(this.captureIndex).padStart(2, '0')}`;
        this.status.set(`processing ${label}`);
        this.send(
            {
                kind: 'frame',
                label,
                work: {
                    width: work.width,
                    height: work.height,
                    pixels: work.data.buffer as ArrayBuffer,
                },
                compose: {
                    width: compose.width,
                    height: compose.height,
                    pixels: compose.data.buffer as ArrayBuffer,
                },
            },
            [work.data.buffer as ArrayBuffer, compose.data.buffer as ArrayBuffer],
        );
    }

    private workWidth(): number {
        return this.sessionWorkWidth ?? this.params().detect.workWidth;
    }

    private rasterizePreview(source: HTMLVideoElement): ImageData | null {
        const scale = Math.min(1, this.workWidth() / source.videoWidth);
        const width = Math.max(32, Math.round(source.videoWidth * scale));
        const height = Math.max(32, Math.round(source.videoHeight * scale));
        let context = this.previewCanvas;
        if (!context || context.canvas.width !== width || context.canvas.height !== height) {
            context = new OffscreenCanvas(width, height).getContext('2d', {
                willReadFrequently: true,
            });
            this.previewCanvas = context;
        }
        if (!context) return null;
        context.drawImage(source, 0, 0, width, height);
        return context.getImageData(0, 0, width, height);
    }

    private rasterize(
        source: HTMLVideoElement | OffscreenCanvas,
        width: number,
        height: number,
        targetWidth: number,
    ): ImageData | null {
        const scale = Math.min(1, targetWidth / width);
        const w = Math.max(32, Math.round(width * scale));
        const h = Math.max(32, Math.round(height * scale));
        const canvas = new OffscreenCanvas(w, h);
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) return null;
        context.drawImage(source, 0, 0, w, h);
        return context.getImageData(0, 0, w, h);
    }

    exportPanorama(): Promise<Blob> {
        return new Promise((resolve, reject) => {
            if (!this.mosaic()) {
                reject(new Error('empty mosaic'));
                return;
            }
            this.settleExport(new Error('export superseded'));
            this.busy.set(true);
            this.pendingExport = { resolve, reject };
            this.send({ kind: 'export' });
        });
    }

    private settleExport(error: Error): void {
        this.pendingExport?.reject(error);
        this.pendingExport = null;
    }

    reset(): void {
        this.epoch += 1;
        this.previewInFlight = false;
        this.settleExport(new Error('pipeline reset'));
        this.reports.set([]);
        this.connection.set(null);
        this.preview.set(null);
        this.mosaic.set(null);
        this.graph.set({ nodes: [], edges: [], order: [], reference: -1, components: 0 });
        this.captureIndex = 0;
        this.sessionWorkWidth = null;
        this.error.set(null);
        this.status.set('pipeline reset');
        this.send({ kind: 'reset' });
    }
}
