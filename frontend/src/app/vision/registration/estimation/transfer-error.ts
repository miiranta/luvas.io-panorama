import { Mat3 } from '../../foundation/math/matrix3';
import { Correspondence } from './correspondence';

function projectionError(m: Mat3, x: number, y: number, targetX: number, targetY: number): number {
    const w = m[6] * x + m[7] * y + m[8];
    if (Math.abs(w) < 1e-12) return Number.POSITIVE_INFINITY;
    const projectedX = (m[0] * x + m[1] * y + m[2]) / w;
    const projectedY = (m[3] * x + m[4] * y + m[5]) / w;
    return Math.hypot(projectedX - targetX, projectedY - targetY);
}

export function transferError(m: Mat3, p: Correspondence): number {
    return projectionError(m, p.sx, p.sy, p.dx, p.dy);
}

export function symmetricTransferError(m: Mat3, inverse: Mat3 | null, p: Correspondence): number {
    const forward = transferError(m, p);
    if (!inverse) return forward;
    const backward = projectionError(inverse, p.dx, p.dy, p.sx, p.sy);
    return Math.sqrt((forward * forward + backward * backward) / 2);
}
