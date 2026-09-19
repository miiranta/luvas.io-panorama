import { PipelineParams } from './params';
import {
    ConnectionPayload,
    FrameReport,
    GraphPayload,
    MosaicPayload,
    PreviewPayload,
} from './reports';

export interface RasterPayload {
    width: number;
    height: number;
    pixels: ArrayBuffer;
}

interface RgbaImage {
    width: number;
    height: number;
    data: Uint8ClampedArray<ArrayBuffer>;
}

export function toRasterPayload(image: RgbaImage): RasterPayload {
    return { width: image.width, height: image.height, pixels: image.data.buffer };
}

export function fromRasterPayload(payload: RasterPayload): RgbaImage {
    return {
        width: payload.width,
        height: payload.height,
        data: new Uint8ClampedArray(payload.pixels),
    };
}

export interface PipelineState {
    busy: boolean;
    stage: string;
    progress: number;
    stale: boolean;
}

export type WorkerRequest =
    | { kind: 'params'; params: PipelineParams }
    | {
          kind: 'frame';
          label: string;
          work: RasterPayload;
          compose: RasterPayload;
      }
    | {
          kind: 'preview';
          epoch: number;
          work: RasterPayload;
      }
    | { kind: 'recompose' }
    | { kind: 'resolve' }
    | { kind: 'reset' }
    | { kind: 'export' };

export type WorkerResponse =
    | { kind: 'ready' }
    | { kind: 'frame'; report: FrameReport; connection: ConnectionPayload | null }
    | { kind: 'mosaic'; mosaic: MosaicPayload }
    | { kind: 'graph'; graph: GraphPayload }
    | { kind: 'preview'; epoch: number; preview: PreviewPayload | null }
    | { kind: 'export'; width: number; height: number; png: ArrayBuffer }
    | { kind: 'state'; state: PipelineState }
    | { kind: 'progress'; detail: string }
    | { kind: 'error'; message: string; request?: WorkerRequest['kind'] };
