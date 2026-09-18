/// <reference lib="webworker" />

import { WorkerRequest, WorkerResponse } from '../core/models/worker-protocol';
import { StitchPipeline } from '../vision/pipeline/stitch-pipeline';

const pipeline = new StitchPipeline();
let queue: Promise<void> = Promise.resolve();
let pending = 0;
let stale = false;
let settleTimer: number | null = null;

const SETTLE_DELAY = 400;

function post(message: WorkerResponse, transfer: Transferable[] = []): void {
    (self as unknown as Worker).postMessage(message, transfer);
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

function publishMosaic(): void {
    const mosaic = pipeline.mosaicPayload();
    if (mosaic) post({ kind: 'mosaic', mosaic }, [mosaic.pixels]);
    post({ kind: 'graph', graph: pipeline.graph() });
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
                const work = {
                    width: request.work.width,
                    height: request.work.height,
                    data: new Uint8ClampedArray(request.work.pixels),
                };
                const compose = {
                    width: request.compose.width,
                    height: request.compose.height,
                    data: new Uint8ClampedArray(request.compose.pixels),
                };
                const { report, connection } = await pipeline.addFrame(
                    request.label,
                    work,
                    compose,
                );
                const transfer: Transferable[] = [];
                if (connection) transfer.push(connection.queryImage, connection.trainImage);
                post({ kind: 'frame', report, connection }, transfer);
                publishMosaic();
                break;
            }
            case 'preview': {
                const work = {
                    width: request.work.width,
                    height: request.work.height,
                    data: new Uint8ClampedArray(request.work.pixels),
                };
                post({
                    kind: 'preview',
                    epoch: request.epoch,
                    preview: pipeline.previewMatch(work),
                });
                break;
            }
            case 'recompose': {
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
                const image = await pipeline.exportImage();
                if (image) {
                    post(
                        {
                            kind: 'export',
                            width: image.width,
                            height: image.height,
                            png: image.png,
                        },
                        [image.png],
                    );
                } else {
                    post({ kind: 'error', message: 'nothing to export' });
                }
                break;
            }
        }
    } catch (error) {
        post({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
}

async function settle(): Promise<void> {
    if (pending > 0 || !pipeline.needsSettle()) return;
    postState('refining alignment', -1);
    if (await pipeline.settle()) publishMosaic();
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
    }, SETTLE_DELAY) as unknown as number;
}

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
    const request = event.data;
    const counted = tracked(request);
    if (settleTimer !== null) {
        clearTimeout(settleTimer);
        settleTimer = null;
    }
    if (counted) {
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
        post({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
    post({ kind: 'ready' });
    postState('ready', 1);
});
