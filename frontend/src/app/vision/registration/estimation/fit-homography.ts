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
