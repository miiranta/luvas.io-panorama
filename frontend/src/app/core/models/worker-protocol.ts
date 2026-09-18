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
    | ({ kind: 'export' } & RasterPayload)
    | { kind: 'progress'; detail: string }
    | { kind: 'error'; message: string };
