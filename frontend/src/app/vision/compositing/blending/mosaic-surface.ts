import { BlurBackend } from './blur-backend';
import { CanvasBox } from '../warping/canvas-box';
import { WarpTile } from '../warping/warp-tile';

export interface MosaicView {
    u0: number;
    v0: number;
    canvasWidth: number;
}

export interface TileSnapshot {
    width: number;
    height: number;
    step: number;
    mean: Float32Array;
    filled: Uint8Array;
    covered: Uint8Array;
}

export interface MosaicSurface {
    readonly kind: string;
    readonly width: number;
    readonly height: number;
    readonly bands: number;
    snapshot(tile: WarpTile, step: number): TileSnapshot;
    addFlat(tile: WarpTile): void;
    addPyramidBands(tile: WarpTile, blur: BlurBackend): void;
    render(useBands: boolean, overlay?: MosaicSurface | null, region?: CanvasBox | null): ImageData;
    boundingBox(overlay?: MosaicSurface | null): CanvasBox | null;
    coveredCount(box: CanvasBox, overlay?: MosaicSurface | null): number;
    reset(): void;
    dispose(): void;
}

export function snapshotGrid(tile: WarpTile, step: number): { width: number; height: number } {
    return {
        width: Math.max(1, Math.ceil(tile.width / step)),
        height: Math.max(1, Math.ceil(tile.height / step)),
    };
}

export function cellSource(tile: WarpTile, step: number, x: number, y: number): [number, number] {
    return [
        Math.min(tile.width - 1, x * step + (step >> 1)),
        Math.min(tile.height - 1, y * step + (step >> 1)),
    ];
}

export type MosaicFactory = (
    width: number,
    height: number,
    bands: number,
    view?: MosaicView,
) => MosaicSurface;
