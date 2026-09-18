import { ModelKind } from '../../core/models/params';
import { smallestEigenvector, solveLinearSystem } from '../math/decomposition';
import { Mat3, mat3Identity, mat3Inverse, mat3Multiply } from '../math/matrix3';

export interface Correspondence {
    sx: number;
    sy: number;
    dx: number;
    dy: number;
}

export const MIN_PAIRS: Record<ModelKind, number> = {
    translation: 1,
    similarity: 2,
    affine: 3,
    homography: 4,
};

function normalize(points: readonly Correspondence[], indices: readonly number[], source: boolean) {
    let mx = 0;
    let my = 0;
    for (const i of indices) {
        mx += source ? points[i].sx : points[i].dx;
        my += source ? points[i].sy : points[i].dy;
    }
    mx /= indices.length;
    my /= indices.length;
    let mean = 0;
    for (const i of indices) {
        const x = (source ? points[i].sx : points[i].dx) - mx;
        const y = (source ? points[i].sy : points[i].dy) - my;
        mean += Math.hypot(x, y);
    }
    mean /= indices.length;
    const scale = mean < 1e-9 ? 1 : Math.SQRT2 / mean;
    const t = mat3Identity();
    t[0] = scale;
    t[2] = -scale * mx;
    t[4] = scale;
    t[5] = -scale * my;
    return { matrix: t, scale, mx, my };
}

function fitHomography(points: readonly Correspondence[], indices: readonly number[]): Mat3 | null {
    if (indices.length < 4) return null;
    const ns = normalize(points, indices, true);
    const nd = normalize(points, indices, false);
    const rows = indices.length * 2;
    const ata = new Float64Array(81);
    const row = new Float64Array(9);
    for (let k = 0; k < indices.length; k++) {
        const p = points[indices[k]];
        const sx = ns.scale * (p.sx - ns.mx);
        const sy = ns.scale * (p.sy - ns.my);
        const dx = nd.scale * (p.dx - nd.mx);
        const dy = nd.scale * (p.dy - nd.my);
        row.fill(0);
        row[0] = -sx;
        row[1] = -sy;
        row[2] = -1;
        row[6] = dx * sx;
        row[7] = dx * sy;
        row[8] = dx;
        for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) ata[i * 9 + j] += row[i] * row[j];
        row.fill(0);
        row[3] = -sx;
        row[4] = -sy;
        row[5] = -1;
        row[6] = dy * sx;
        row[7] = dy * sy;
        row[8] = dy;
        for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) ata[i * 9 + j] += row[i] * row[j];
    }
    if (rows < 8) return null;
    const h = smallestEigenvector(ata, 9);
    const hn = new Float64Array(9);
    for (let i = 0; i < 9; i++) hn[i] = h[i];
    const invD = mat3Inverse(nd.matrix);
    if (!invD) return null;
    const denorm = mat3Multiply(invD, mat3Multiply(hn, ns.matrix));
    if (Math.abs(denorm[8]) < 1e-12) return null;
    const scale = 1 / denorm[8];
    for (let i = 0; i < 9; i++) denorm[i] *= scale;
    return denorm;
}

function fitAffine(points: readonly Correspondence[], indices: readonly number[]): Mat3 | null {
    if (indices.length < 3) return null;
    const ata = new Float64Array(36);
    const atb = new Float64Array(6);
    for (const i of indices) {
        const p = points[i];
        const rows = [
            [p.sx, p.sy, 1, 0, 0, 0, p.dx],
            [0, 0, 0, p.sx, p.sy, 1, p.dy],
        ];
        for (const r of rows) {
            for (let a = 0; a < 6; a++) {
                for (let b = 0; b < 6; b++) ata[a * 6 + b] += r[a] * r[b];
                atb[a] += r[a] * r[6];
            }
        }
    }
    const solution = solveLinearSystem(ata, atb, 6);
    if (!solution) return null;
    const m = mat3Identity();
    m[0] = solution[0];
    m[1] = solution[1];
    m[2] = solution[2];
    m[3] = solution[3];
    m[4] = solution[4];
    m[5] = solution[5];
    return m;
}

function fitSimilarity(points: readonly Correspondence[], indices: readonly number[]): Mat3 | null {
    if (indices.length < 2) return null;
    const ata = new Float64Array(16);
    const atb = new Float64Array(4);
    for (const i of indices) {
        const p = points[i];
        const rows = [
            [p.sx, -p.sy, 1, 0, p.dx],
            [p.sy, p.sx, 0, 1, p.dy],
        ];
        for (const r of rows) {
            for (let a = 0; a < 4; a++) {
                for (let b = 0; b < 4; b++) ata[a * 4 + b] += r[a] * r[b];
                atb[a] += r[a] * r[4];
            }
        }
    }
    const solution = solveLinearSystem(ata, atb, 4);
    if (!solution) return null;
    const m = mat3Identity();
    m[0] = solution[0];
    m[1] = -solution[1];
    m[2] = solution[2];
    m[3] = solution[1];
    m[4] = solution[0];
    m[5] = solution[3];
    return m;
}

function fitTranslation(
    points: readonly Correspondence[],
    indices: readonly number[],
): Mat3 | null {
    if (indices.length < 1) return null;
    let tx = 0;
    let ty = 0;
    for (const i of indices) {
        tx += points[i].dx - points[i].sx;
        ty += points[i].dy - points[i].sy;
    }
    const m = mat3Identity();
    m[2] = tx / indices.length;
    m[5] = ty / indices.length;
    return m;
}

export function fitModel(
    kind: ModelKind,
    points: readonly Correspondence[],
    indices: readonly number[],
): Mat3 | null {
    switch (kind) {
        case 'translation':
            return fitTranslation(points, indices);
        case 'similarity':
            return fitSimilarity(points, indices);
        case 'affine':
            return fitAffine(points, indices);
        default:
            return fitHomography(points, indices);
    }
}

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

export function isPlausibleHomography(m: Mat3, kind: ModelKind, maxSkew: number): boolean {
    for (let i = 0; i < 9; i++) if (!isFinite(m[i])) return false;
    const det = m[0] * m[4] - m[1] * m[3];
    if (det <= 1e-6) return false;
    if (kind !== 'homography') return true;
    const scale = Math.sqrt(det);
    if (scale < 0.1 || scale > 10) return false;
    const skew = Math.hypot(m[6], m[7]);
    return skew < maxSkew;
}
