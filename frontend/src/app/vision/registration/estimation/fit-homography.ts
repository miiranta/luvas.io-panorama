import { solveLinearSystem } from '../../foundation/math/gaussian-elimination';
import { smallestEigenvector } from '../../foundation/math/jacobi-eigen';
import { Mat3, mat3Inverse, mat3Multiply } from '../../foundation/math/matrix3';
import { Correspondence } from './correspondence';
import { hartleyNormalization } from './hartley-normalization';

export function fitHomography(
    points: readonly Correspondence[],
    indices: readonly number[],
): Mat3 | null {
    if (indices.length < 4) return null;
    const ns = hartleyNormalization(points, indices, true);
    const nd = hartleyNormalization(points, indices, false);
    if (indices.length === 4) return minimalHomography(points, indices, ns, nd);
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
    return denormalize(Float64Array.from(smallestEigenvector(ata, 9)), ns.matrix, nd.matrix);
}

type Normalization = ReturnType<typeof hartleyNormalization>;

function minimalHomography(
    points: readonly Correspondence[],
    indices: readonly number[],
    ns: Normalization,
    nd: Normalization,
): Mat3 | null {
    const a = new Float64Array(64);
    const b = new Float64Array(8);
    for (let k = 0; k < 4; k++) {
        const p = points[indices[k]];
        const sx = ns.scale * (p.sx - ns.mx);
        const sy = ns.scale * (p.sy - ns.my);
        const dx = nd.scale * (p.dx - nd.mx);
        const dy = nd.scale * (p.dy - nd.my);
        const first = k * 2 * 8;
        const second = first + 8;
        a[first] = sx;
        a[first + 1] = sy;
        a[first + 2] = 1;
        a[first + 6] = -dx * sx;
        a[first + 7] = -dx * sy;
        b[k * 2] = dx;
        a[second + 3] = sx;
        a[second + 4] = sy;
        a[second + 5] = 1;
        a[second + 6] = -dy * sx;
        a[second + 7] = -dy * sy;
        b[k * 2 + 1] = dy;
    }
    const solution = solveLinearSystem(a, b, 8);
    if (!solution) return null;
    const h = new Float64Array(9);
    h.set(solution);
    h[8] = 1;
    return denormalize(h, ns.matrix, nd.matrix);
}

function denormalize(h: Mat3, source: Mat3, target: Mat3): Mat3 | null {
    const inverse = mat3Inverse(target);
    if (!inverse) return null;
    const denorm = mat3Multiply(inverse, mat3Multiply(h, source));
    if (Math.abs(denorm[8]) < 1e-12) return null;
    const scale = 1 / denorm[8];
    for (let i = 0; i < 9; i++) denorm[i] *= scale;
    return denorm;
}
