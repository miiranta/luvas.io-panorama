import { SurfaceKind } from '../../../core/models/params';
import { Mat3, mat3Identity, mat3Transpose } from '../../foundation/math/matrix3';
import { CanvasBox, PYRAMID_ALIGNMENT, alignUp } from './canvas-box';

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

export function worldToCanvas(
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
