import { solveLinearSystem } from '../../foundation/math/gaussian-elimination';
import { Mat3, mat3Identity } from '../../foundation/math/matrix3';
import { Correspondence } from './correspondence';

export function fitSimilarity(
    points: readonly Correspondence[],
    indices: readonly number[],
): Mat3 | null {
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
