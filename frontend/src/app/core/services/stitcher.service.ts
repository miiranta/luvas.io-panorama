import { Injectable, computed, signal } from '@angular/core';
import { DEFAULT_PARAMS, ParamGroup, PipelineParams } from '../models/params';
import {
    ConnectionPayload,
    FrameReport,
    GraphPayload,
    MosaicPayload,
    PreviewPayload,
} from '../models/reports';
import { WorkerRequest, WorkerResponse } from '../models/worker-protocol';

const PREVIEW_INTERVAL = 260;

@Injectable({ providedIn: 'root' })
export class StitcherService {
    private worker: Worker | null = null;
    private pendingExport: ((blob: Blob) => void) | null = null;
    private captureIndex = 0;
    private previewTimer: number | null = null;
    private previewInFlight = false;
    private previewSource: HTMLVideoElement | null = null;
    private epoch = 0;

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

    readonly acceptedFrames = computed(() => this.reports().filter((r) => r.accepted).length);
    readonly rejectedFrames = computed(() => this.reports().filter((r) => !r.accepted).length);
    readonly lastReport = computed(() => this.reports().at(-1) ?? null);

    start(): void {
        if (this.worker) return;
        this.worker = new Worker(new URL('../../workers/stitch.worker', import.meta.url), {
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
                this.status.set('pronto');
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
            case 'preview':
                if (message.epoch !== this.epoch) break;
                this.previewInFlight = false;
                this.preview.set(message.preview);
                break;
            case 'progress':
                this.status.set(message.detail);
                break;
            case 'export': {
                const data = new Uint8ClampedArray(message.pixels);
                const image = new ImageData(data, message.width, message.height);
                const canvas = document.createElement('canvas');
                canvas.width = message.width;
                canvas.height = message.height;
                canvas.getContext('2d')?.putImageData(image, 0, 0);
                canvas.toBlob((blob) => {
                    if (blob && this.pendingExport) this.pendingExport(blob);
                    this.pendingExport = null;
                    this.busy.set(false);
                }, 'image/png');
                break;
            }
            case 'error':
                this.error.set(message.message);
                this.busy.set(false);
                break;
        }
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
        this.busy.set(true);
        this.status.set('recompositing mosaic');
        this.send({ kind: 'recompose' });
        queueMicrotask(() => this.busy.set(false));
    }

    resolveFromScratch(): void {
        if (this.reports().length < 2) return;
        this.busy.set(true);
        this.status.set('reordering from the graph');
        this.send({ kind: 'resolve' });
        queueMicrotask(() => this.busy.set(false));
    }

    trackLive(source: HTMLVideoElement): void {
        this.previewSource = source;
        if (this.previewTimer !== null) return;
        this.previewTimer = setInterval(
            () => this.tickPreview(),
            PREVIEW_INTERVAL,
        ) as unknown as number;
    }

    stopTracking(): void {
        if (this.previewTimer !== null) clearInterval(this.previewTimer);
        this.previewTimer = null;
        this.previewSource = null;
        this.previewInFlight = false;
        this.preview.set(null);
    }

    private tickPreview(): void {
        const source = this.previewSource;
        if (!source || this.previewInFlight || this.busy()) return;
        if (this.reports().every((report) => !report.accepted)) return;
        if (source.readyState < 2 || !source.videoWidth) return;
        const frame = this.rasterize(
            source,
            source.videoWidth,
            source.videoHeight,
            this.params().detect.workWidth,
        );
        if (!frame) return;
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
        const work = this.rasterize(snapshot, width, height, params.detect.workWidth);
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
            this.busy.set(true);
            this.pendingExport = resolve;
            this.send({ kind: 'export' });
        });
    }

    reset(): void {
        this.epoch += 1;
        this.previewInFlight = false;
        this.reports.set([]);
        this.connection.set(null);
        this.preview.set(null);
        this.mosaic.set(null);
        this.graph.set({ nodes: [], edges: [], order: [], reference: -1, components: 0 });
        this.captureIndex = 0;
        this.error.set(null);
        this.status.set('pipeline reset');
        this.send({ kind: 'reset' });
    }
}
