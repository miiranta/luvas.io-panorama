/// <reference lib="webworker" />

import { WorkerRequest, WorkerResponse, fromRasterPayload } from '../models/worker-protocol';
import { StitchPipeline } from '../../vision/pipeline/stitch-pipeline';

const pipeline = new StitchPipeline();
let queue: Promise<void> = Promise.resolve();
let pending = 0;
let stale = false;
let settleTimer: number | null = null;
let queuedRecomposes = 0;

const SETTLE_DELAY = 400;

function post(message: WorkerResponse, transfer: Transferable[] = []): void {
    self.postMessage(message, transfer);
}

function postState(stage: string, progress: number): void {
    post({ kind: 'state', state: { busy: pending > 0, stage, progress, stale } });
}

function tracked(request: WorkerRequest): boolean {
    return request.kind !== 'preview';
}

function invalidates(request: WorkerRequest): boolean {
    return (
        request.kind === 'frame' ||
        request.kind === 'params' ||
        request.kind === 'recompose' ||
        request.kind === 'resolve'
    );
}

function stageFor(request: WorkerRequest): string {
    switch (request.kind) {
        case 'frame':
            return 'merging photo';
        case 'recompose':
            return 'recompositing mosaic';
        case 'resolve':
            return 'matching all pairs';
        case 'export':
            return 'rendering export';
        case 'params':
            return 'applying parameters';
        default:
            return 'working';
    }
}

pipeline.setReporter((stage, progress) => postState(stage, progress));

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function publishMosaic(): void {
    const mosaic = pipeline.mosaicPayload();
    if (mosaic) post({ kind: 'mosaic', mosaic }, [mosaic.pixels]);
    post({ kind: 'graph', graph: pipeline.graph() });
}

async function refineAlignment(): Promise<void> {
    if (!pipeline.needsSettle()) return;
    postState('refining alignment', -1);
    if (await pipeline.settle()) publishMosaic();
}

async function exportPanorama(): Promise<void> {
    await refineAlignment();
    const image = await pipeline.exportImage();
    if (!image) {
        post({ kind: 'error', message: 'nothing to export', request: 'export' });
        return;
    }
    const { width, height, png } = image;
    post({ kind: 'export', width, height, png }, [png]);
}

async function handle(request: WorkerRequest): Promise<void> {
    try {
        switch (request.kind) {
            case 'params': {
                pipeline.setParams(request.params);
                post({ kind: 'progress', detail: 'parameters applied' });
                break;
            }
            case 'frame': {
                const { report, connection } = await pipeline.addFrame(
                    request.label,
                    fromRasterPayload(request.work),
                    fromRasterPayload(request.compose),
                );
                const transfer: Transferable[] = [];
                if (connection) transfer.push(connection.queryImage, connection.trainImage);
                post({ kind: 'frame', report, connection }, transfer);
                publishMosaic();
                break;
            }
            case 'preview': {
                post({
                    kind: 'preview',
                    epoch: request.epoch,
                    preview: pipeline.previewMatch(fromRasterPayload(request.work)),
                });
                break;
            }
            case 'recompose': {
                queuedRecomposes--;
                if (queuedRecomposes > 0) break;
                await pipeline.recompose();
                publishMosaic();
                break;
            }
            case 'resolve': {
                post({ kind: 'progress', detail: 'matching all pairs' });
                await pipeline.resolveFromScratch();
                publishMosaic();
                post({ kind: 'progress', detail: 'order inferred from the graph' });
                break;
            }
            case 'reset': {
                pipeline.reset();
                post({ kind: 'graph', graph: pipeline.graph() });
                break;
            }
            case 'export': {
                await exportPanorama();
                break;
            }
        }
    } catch (error) {
        post({ kind: 'error', message: messageOf(error), request: request.kind });
    }
}

async function settle(): Promise<void> {
    if (pending > 0) return;
    try {
        await refineAlignment();
    } catch (error) {
        post({ kind: 'error', message: messageOf(error) });
    }
}

function scheduleSettle(): void {
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
        settleTimer = null;
        if (pending > 0) return;
        queue = queue.then(async () => {
            await settle();
            postState('ready', 1);
        });
    }, SETTLE_DELAY);
}

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
    const request = event.data;
    const counted = tracked(request);
    if (request.kind === 'recompose') queuedRecomposes++;
    if (counted) {
        if (settleTimer !== null) {
            clearTimeout(settleTimer);
            settleTimer = null;
        }
        pending++;
        if (invalidates(request)) stale = true;
        postState(stageFor(request), -1);
    }
    queue = queue
        .then(() => handle(request))
        .then(async () => {
            if (!counted) return;
            pending--;
            if (pending > 0) {
                postState('working', -1);
                return;
            }
            stale = false;
            postState('ready', 1);
            scheduleSettle();
        });
});

queue = queue.then(() => {
    try {
        pipeline.warmup();
    } catch (error) {
        post({ kind: 'error', message: messageOf(error) });
    }
    post({ kind: 'ready' });
    postState('ready', 1);
});
