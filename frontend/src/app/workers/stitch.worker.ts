/// <reference lib="webworker" />

import { WorkerRequest, WorkerResponse } from '../core/models/worker-protocol';
import { StitchPipeline } from '../vision/pipeline/stitch-pipeline';

const pipeline = new StitchPipeline();
let queue: Promise<void> = Promise.resolve();

function post(message: WorkerResponse, transfer: Transferable[] = []): void {
    (self as unknown as Worker).postMessage(message, transfer);
}

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
                const image = pipeline.exportImage();
                if (image) {
                    post(
                        {
                            kind: 'export',
                            width: image.width,
                            height: image.height,
                            pixels: image.pixels,
                        },
                        [image.pixels],
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

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
    queue = queue.then(() => handle(event.data));
});

post({ kind: 'ready' });
