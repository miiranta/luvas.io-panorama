import { CanvasGeometry } from './canvas-geometry';

export interface CanvasTransfer {
    scaleU: number;
    offsetU: number;
    scaleV: number;
    offsetV: number;
}

export function canvasTransfer(from: CanvasGeometry, to: CanvasGeometry): CanvasTransfer {
    if (from.surface === 'planar') {
        const scale = to.planarScale / from.planarScale;
        return {
            scaleU: scale,
            offsetU: to.width / 2 - (scale * from.width) / 2,
            scaleV: scale,
            offsetV: to.height / 2 - (scale * from.height) / 2,
        };
    }
    const scaleU = to.width / from.width;
    if (from.surface === 'spherical') {
        return { scaleU, offsetU: 0, scaleV: to.height / from.height, offsetV: 0 };
    }
    return {
        scaleU,
        offsetU: 0,
        scaleV: scaleU,
        offsetV: to.height / 2 - (scaleU * from.height) / 2,
    };
}
