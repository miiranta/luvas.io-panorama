import { solveLinearSystem } from '../../foundation/math/gaussian-elimination';
import { Mat3, mat3Identity } from '../../foundation/math/matrix3';
import { Correspondence, localizationWeight } from './correspondence';

export function fitAffine(
    points: readonly Correspondence[],
    indices: readonly number[],
): Mat3 | null {
    if (indices.length < 3) return null;
    const ata = new Float64Array(36);
    const atb = new Float64Array(6);
    for (const i of indices) {
        const p = points[i];
        const weight = localizationWeight(p);
        const rows = [
            [p.sx, p.sy, 1, 0, 0, 0, p.dx],
            [0, 0, 0, p.sx, p.sy, 1, p.dy],
        ];
        for (const r of rows) {
            for (let a = 0; a < 6; a++) {
                for (let b = 0; b < 6; b++) ata[a * 6 + b] += weight * r[a] * r[b];
                atb[a] += weight * r[a] * r[6];
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
