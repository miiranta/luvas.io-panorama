import { solveLinearSystem } from '../../foundation/math/gaussian-elimination';
import { smallestEigenvector } from '../../foundation/math/jacobi-eigen';
import { Mat3, mat3Inverse, mat3Multiply } from '../../foundation/math/matrix3';
import { Correspondence, localizationWeight } from './correspondence';
import { hartleyNormalization } from './hartley-normalization';

export function fitHomography(
    points: readonly Correspondence[],
    indices: readonly number[],
): Mat3 | null {
    if (indices.length < 4) return null;
    const ns = hartleyNormalization(points, indices, true);
    const nd = hartleyNormalization(points, indices, false);
    if (indices.length === 4) return minimalHomography(points, indices, ns, nd);
    const ata = new Float64Array(81);
    const rows = new Float64Array(18);
    for (const index of indices) {
        const p = points[index];
        const weight = localizationWeight(p);
        dltRows(p, ns, nd, rows);
        for (let row = 0; row < 18; row += 9) {
            for (let i = 0; i < 9; i++) {
                for (let j = 0; j < 9; j++)
                    ata[i * 9 + j] += weight * rows[row + i] * rows[row + j];
            }
        }
    }
    return denormalize(Float64Array.from(smallestEigenvector(ata, 9)), ns.matrix, nd.matrix);
}

type Normalization = ReturnType<typeof hartleyNormalization>;

function dltRows(
    p: Correspondence,
    ns: Normalization,
    nd: Normalization,
    rows: Float64Array,
): void {
    const sx = ns.scale * (p.sx - ns.mx);
    const sy = ns.scale * (p.sy - ns.my);
    const dx = nd.scale * (p.dx - nd.mx);
    const dy = nd.scale * (p.dy - nd.my);
    rows.fill(0);
    rows[0] = -sx;
    rows[1] = -sy;
    rows[2] = -1;
    rows[6] = dx * sx;
    rows[7] = dx * sy;
    rows[8] = dx;
    rows[12] = -sx;
    rows[13] = -sy;
    rows[14] = -1;
    rows[15] = dy * sx;
    rows[16] = dy * sy;
    rows[17] = dy;
}

function minimalHomography(
    points: readonly Correspondence[],
    indices: readonly number[],
    ns: Normalization,
    nd: Normalization,
): Mat3 | null {
    const a = new Float64Array(64);
    const b = new Float64Array(8);
    const rows = new Float64Array(18);
    for (let k = 0; k < 4; k++) {
        dltRows(points[indices[k]], ns, nd, rows);
        for (let row = 0; row < 2; row++) {
            const equation = k * 2 + row;
            for (let i = 0; i < 8; i++) a[equation * 8 + i] = 0 - rows[row * 9 + i];
            b[equation] = rows[row * 9 + 8];
        }
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
