import { Mat3 } from '../../foundation/math/matrix3';
import { Correspondence } from './correspondence';

export function transferError(m: Mat3, p: Correspondence): number {
    const w = m[6] * p.sx + m[7] * p.sy + m[8];
    if (Math.abs(w) < 1e-12) return Number.POSITIVE_INFINITY;
    const x = (m[0] * p.sx + m[1] * p.sy + m[2]) / w;
    const y = (m[3] * p.sx + m[4] * p.sy + m[5]) / w;
    return Math.hypot(x - p.dx, y - p.dy);
}

export function symmetricTransferError(m: Mat3, inverse: Mat3 | null, p: Correspondence): number {
    const forward = transferError(m, p);
    if (!inverse) return forward;
    const w = inverse[6] * p.dx + inverse[7] * p.dy + inverse[8];
    if (Math.abs(w) < 1e-12) return Number.POSITIVE_INFINITY;
    const x = (inverse[0] * p.dx + inverse[1] * p.dy + inverse[2]) / w;
    const y = (inverse[3] * p.dx + inverse[4] * p.dy + inverse[5]) / w;
    const backward = Math.hypot(x - p.sx, y - p.sy);
    return Math.sqrt((forward * forward + backward * backward) / 2);
}
