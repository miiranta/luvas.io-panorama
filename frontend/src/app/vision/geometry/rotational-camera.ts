import { Mat3, mat3Identity, mat3Inverse, mat3Multiply, mat3Transpose } from '../math/matrix3';
import { nearestRotation } from '../math/so3';

const MIN_FOCAL = 50;
const MAX_FOCAL = 20000;

function intrinsics(focal: number, cx: number, cy: number): Mat3 {
    const k = mat3Identity();
    k[0] = focal;
    k[2] = cx;
    k[4] = focal;
    k[5] = cy;
    return k;
}

export function focalFromHomography(raw: Mat3, cx = 0, cy = 0): number | null {
    const centred = mat3Multiply(translation(-cx, -cy), mat3Multiply(raw, translation(cx, cy)));
    const inverse = mat3Inverse(centred);
    const candidates = [
        ...focalCandidates(centred),
        ...(inverse ? focalCandidates(inverse) : []),
    ].filter((f) => isFinite(f) && f > MIN_FOCAL && f < MAX_FOCAL);
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a - b);
    const mid = Math.floor(candidates.length / 2);
    return candidates.length % 2 === 1
        ? candidates[mid]
        : (candidates[mid - 1] + candidates[mid]) / 2;
}

export function relativeRotationFromHomography(
    h: Mat3,
    focal: number,
    cx: number,
    cy: number,
): Mat3 {
    const k = intrinsics(focal, cx, cy);
    const kInv = mat3Inverse(k) ?? mat3Identity();
    return nearestRotation(mat3Multiply(kInv, mat3Multiply(h, k)));
}

export function homographyFromRotations(
    target: Mat3,
    source: Mat3,
    focal: number,
    cx: number,
    cy: number,
): Mat3 {
    const k = intrinsics(focal, cx, cy);
    const kInv = mat3Inverse(k) ?? mat3Identity();
    return mat3Multiply(k, mat3Multiply(mat3Multiply(target, mat3Transpose(source)), kInv));
}

function translation(tx: number, ty: number): Mat3 {
    const m = mat3Identity();
    m[2] = tx;
    m[5] = ty;
    return m;
}

function focalCandidates(matrix: Mat3): number[] {
    const scale = Math.abs(matrix[8]) > 1e-12 ? 1 / matrix[8] : 1;
    const h = matrix.map((value) => value * scale);
    const found: number[] = [];
    const d1 = h[6] * h[7];
    if (Math.abs(d1) > 1e-16) {
        const f2 = -(h[0] * h[1] + h[3] * h[4]) / d1;
        if (f2 > 0) found.push(Math.sqrt(f2));
    }
    const d2 = h[6] * h[6] - h[7] * h[7];
    if (Math.abs(d2) > 1e-16) {
        const f2 = (h[1] * h[1] + h[4] * h[4] - h[0] * h[0] - h[3] * h[3]) / d2;
        if (f2 > 0) found.push(Math.sqrt(f2));
    }
    return found;
}
