import { undistort } from '../../registration/alignment/lens-distortion';
import { Mat3, mat3Transpose } from '../../foundation/math/matrix3';
import { CanvasBox } from './canvas-box';
import { CanvasGeometry, worldToCanvas } from './canvas-geometry';

export interface Footprint {
    u0: number;
    v0: number;
    u1: number;
    v1: number;
    valid: boolean;
}

export function computeFootprint(
    geometry: CanvasGeometry,
    rotation: Mat3,
    sourceWidth: number,
    sourceHeight: number,
    focal: number,
    distortion = 0,
): Footprint {
    const rt = mat3Transpose(rotation);
    const cx = sourceWidth / 2;
    const cy = sourceHeight / 2;
    const out = new Float64Array(2);
    const lens = new Float64Array(2);
    const samples = 24;
    const us: number[] = [];
    const vs: number[] = [];
    const push = (px: number, py: number) => {
        undistort((px - cx) / focal, (py - cy) / focal, distortion, lens);
        const ax = lens[0];
        const ay = lens[1];
        const wx = rt[0] * ax + rt[1] * ay + rt[2];
        const wy = rt[3] * ax + rt[4] * ay + rt[5];
        const wz = rt[6] * ax + rt[7] * ay + rt[8];
        if (worldToCanvas(geometry, wx, wy, wz, out)) {
            us.push(out[0]);
            vs.push(out[1]);
        }
    };
    for (let i = 0; i <= samples; i++) {
        const t = i / samples;
        push(t * (sourceWidth - 1), 0);
        push(t * (sourceWidth - 1), sourceHeight - 1);
        push(0, t * (sourceHeight - 1));
        push(sourceWidth - 1, t * (sourceHeight - 1));
    }
    push(cx, cy);
    if (us.length < 4) return { u0: 0, v0: 0, u1: 0, v1: 0, valid: false };
    const wrap = geometry.surface !== 'planar';
    let u0 = Number.POSITIVE_INFINITY;
    let u1 = Number.NEGATIVE_INFINITY;
    let v0 = Number.POSITIVE_INFINITY;
    let v1 = Number.NEGATIVE_INFINITY;
    if (wrap) {
        let sx = 0;
        let sy = 0;
        for (const u of us) {
            const angle = (u / geometry.width) * Math.PI * 2;
            sx += Math.cos(angle);
            sy += Math.sin(angle);
        }
        const centre =
            ((Math.atan2(sy, sx) / (Math.PI * 2)) * geometry.width + geometry.width) %
            geometry.width;
        for (let i = 0; i < us.length; i++) {
            let u = us[i];
            while (u - centre > geometry.width / 2) u -= geometry.width;
            while (centre - u > geometry.width / 2) u += geometry.width;
            if (u < u0) u0 = u;
            if (u > u1) u1 = u;
        }
    } else {
        for (const u of us) {
            if (u < u0) u0 = u;
            if (u > u1) u1 = u;
        }
    }
    for (const v of vs) {
        if (v < v0) v0 = v;
        if (v > v1) v1 = v;
    }
    if (!wrap) {
        u0 = Math.max(0, u0);
        u1 = Math.min(geometry.width - 1, u1);
    }
    v0 = Math.max(0, v0);
    v1 = Math.min(geometry.height - 1, v1);
    const valid = u1 > u0 && v1 > v0;
    return {
        u0: Math.floor(u0),
        v0: Math.floor(v0),
        u1: Math.ceil(u1),
        v1: Math.ceil(v1),
        valid,
    };
}

export interface FootprintRequest {
    rotation: Mat3;
    width: number;
    height: number;
    focal: number;
    distortion: number;
}

export function unionFootprints(
    geometry: CanvasGeometry,
    frames: readonly FootprintRequest[],
): CanvasBox | null {
    const boxes = frames
        .map((frame) =>
            computeFootprint(
                geometry,
                frame.rotation,
                frame.width,
                frame.height,
                frame.focal,
                frame.distortion,
            ),
        )
        .filter((footprint) => footprint.valid);
    if (boxes.length === 0) return null;
    const wraps = geometry.surface !== 'planar';
    let u0 = boxes[0].u0;
    let u1 = boxes[0].u1;
    let v0 = boxes[0].v0;
    let v1 = boxes[0].v1;
    for (const box of boxes.slice(1)) {
        let low = box.u0;
        let high = box.u1;
        if (wraps) {
            const centre = (u0 + u1) / 2;
            while ((low + high) / 2 - centre > geometry.width / 2) {
                low -= geometry.width;
                high -= geometry.width;
            }
            while (centre - (low + high) / 2 > geometry.width / 2) {
                low += geometry.width;
                high += geometry.width;
            }
        }
        u0 = Math.min(u0, low);
        u1 = Math.max(u1, high);
        v0 = Math.min(v0, box.v0);
        v1 = Math.max(v1, box.v1);
    }
    if (!wraps) {
        u0 = Math.max(0, u0);
        u1 = Math.min(geometry.width - 1, u1);
    } else if (u1 - u0 + 1 > geometry.width) {
        u0 = 0;
        u1 = geometry.width - 1;
    }
    v0 = Math.max(0, v0);
    v1 = Math.min(geometry.height - 1, v1);
    return u1 > u0 && v1 > v0 ? { u0, v0, u1, v1 } : null;
}

export function clipFootprint(
    geometry: CanvasGeometry,
    footprint: { u0: number; u1: number; v0: number; v1: number },
    clip: CanvasBox,
): CanvasBox | null {
    const v0 = Math.max(footprint.v0, clip.v0);
    const v1 = Math.min(footprint.v1, clip.v1);
    if (v1 < v0) return null;
    const shifts = geometry.surface === 'planar' ? [0] : [0, -geometry.width, geometry.width];
    for (const shift of shifts) {
        const u0 = Math.max(footprint.u0 + shift, clip.u0);
        const u1 = Math.min(footprint.u1 + shift, clip.u1);
        if (u1 >= u0) return { u0, u1, v0, v1 };
    }
    return null;
}
