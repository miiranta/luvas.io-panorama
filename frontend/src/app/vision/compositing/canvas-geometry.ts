import { SurfaceKind } from '../../core/models/params';
import { Mat3, mat3Identity, mat3Transpose } from '../math/matrix3';

export interface CanvasBox {
    u0: number;
    v0: number;
    u1: number;
    v1: number;
}

export interface CanvasGeometry {
    surface: SurfaceKind;
    width: number;
    height: number;
    focal: number;
    orientation: Mat3;
    orientationInverse: Mat3;
    planarScale: number;
    cylinderHalfHeight: number;
}

function canvasHeightFor(surface: SurfaceKind, width: number): number {
    if (surface === 'spherical') return Math.round(width / 2);
    if (surface === 'cylindrical') return Math.round(width / 3);
    return Math.round((width * 3) / 4);
}

export const PYRAMID_ALIGNMENT = 64;

export function alignUp(value: number): number {
    return Math.ceil(value / PYRAMID_ALIGNMENT) * PYRAMID_ALIGNMENT;
}

export function alignDown(value: number): number {
    return Math.floor(value / PYRAMID_ALIGNMENT) * PYRAMID_ALIGNMENT;
}

export function createCanvasGeometry(
    surface: SurfaceKind,
    requestedWidth: number,
    focal: number,
    orientation: Mat3 = mat3Identity(),
): CanvasGeometry {
    const width = alignUp(Math.max(PYRAMID_ALIGNMENT, requestedWidth));
    const height = canvasHeightFor(surface, width);
    return {
        surface,
        width,
        height,
        focal,
        orientation,
        orientationInverse: mat3Transpose(orientation),
        planarScale: width / 2.4,
        cylinderHalfHeight: (Math.PI * height) / width,
    };
}

export function canvasRay(
    geometry: CanvasGeometry,
    u: number,
    v: number,
    out: Float64Array,
): boolean {
    const { surface, width, height } = geometry;
    let dx = 0;
    let dy = 0;
    let dz = 0;
    if (surface === 'spherical') {
        const theta = (u / width) * Math.PI * 2 - Math.PI;
        const phi = (v / height) * Math.PI - Math.PI / 2;
        const cosPhi = Math.cos(phi);
        dx = cosPhi * Math.sin(theta);
        dy = Math.sin(phi);
        dz = cosPhi * Math.cos(theta);
    } else if (surface === 'cylindrical') {
        const theta = (u / width) * Math.PI * 2 - Math.PI;
        const h = (v / height - 0.5) * 2 * geometry.cylinderHalfHeight;
        dx = Math.sin(theta);
        dy = h;
        dz = Math.cos(theta);
    } else {
        dx = (u - width / 2) / geometry.planarScale;
        dy = (v - height / 2) / geometry.planarScale;
        dz = 1;
    }
    const m = geometry.orientation;
    out[0] = m[0] * dx + m[1] * dy + m[2] * dz;
    out[1] = m[3] * dx + m[4] * dy + m[5] * dz;
    out[2] = m[6] * dx + m[7] * dy + m[8] * dz;
    return true;
}

function worldToCanvas(
    geometry: CanvasGeometry,
    wx: number,
    wy: number,
    wz: number,
    out: Float64Array,
): boolean {
    const m = geometry.orientationInverse;
    const dx = m[0] * wx + m[1] * wy + m[2] * wz;
    const dy = m[3] * wx + m[4] * wy + m[5] * wz;
    const dz = m[6] * wx + m[7] * wy + m[8] * wz;
    const { surface, width, height } = geometry;
    if (surface === 'spherical') {
        const norm = Math.hypot(dx, dy, dz);
        if (norm < 1e-12) return false;
        const theta = Math.atan2(dx, dz);
        const phi = Math.asin(Math.min(1, Math.max(-1, dy / norm)));
        out[0] = ((theta + Math.PI) / (Math.PI * 2)) * width;
        out[1] = ((phi + Math.PI / 2) / Math.PI) * height;
        return true;
    }
    if (surface === 'cylindrical') {
        const planar = Math.hypot(dx, dz);
        if (planar < 1e-9) return false;
        const theta = Math.atan2(dx, dz);
        const h = dy / planar;
        out[0] = ((theta + Math.PI) / (Math.PI * 2)) * width;
        out[1] = (h / (2 * geometry.cylinderHalfHeight) + 0.5) * height;
        return true;
    }
    if (dz <= 1e-6) return false;
    out[0] = (dx / dz) * geometry.planarScale + width / 2;
    out[1] = (dy / dz) * geometry.planarScale + height / 2;
    return true;
}

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
): Footprint {
    const rt = mat3Transpose(rotation);
    const cx = sourceWidth / 2;
    const cy = sourceHeight / 2;
    const out = new Float64Array(2);
    const samples = 24;
    const us: number[] = [];
    const vs: number[] = [];
    const push = (px: number, py: number) => {
        const ax = (px - cx) / focal;
        const ay = (py - cy) / focal;
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
}

export function unionFootprints(
    geometry: CanvasGeometry,
    frames: readonly FootprintRequest[],
): CanvasBox | null {
    const boxes = frames
        .map((frame) =>
            computeFootprint(geometry, frame.rotation, frame.width, frame.height, frame.focal),
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

export function angularSpan(
    geometry: CanvasGeometry,
    box: CanvasBox,
): { horizontal: number; vertical: number } {
    const toDegrees = 180 / Math.PI;
    const fracU = (box.u1 - box.u0 + 1) / geometry.width;
    if (geometry.surface === 'spherical') {
        return {
            horizontal: fracU * 360,
            vertical: ((box.v1 - box.v0 + 1) / geometry.height) * 180,
        };
    }
    if (geometry.surface === 'cylindrical') {
        const h = (v: number) => (v / geometry.height - 0.5) * 2 * geometry.cylinderHalfHeight;
        return {
            horizontal: fracU * 360,
            vertical: (Math.atan(h(box.v1 + 1)) - Math.atan(h(box.v0))) * toDegrees,
        };
    }
    const angle = (value: number, centre: number) =>
        Math.atan((value - centre) / geometry.planarScale);
    return {
        horizontal:
            (angle(box.u1 + 1, geometry.width / 2) - angle(box.u0, geometry.width / 2)) * toDegrees,
        vertical:
            (angle(box.v1 + 1, geometry.height / 2) - angle(box.v0, geometry.height / 2)) *
            toDegrees,
    };
}
