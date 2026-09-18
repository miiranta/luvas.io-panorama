import { Mat3, mat3Identity } from '../../foundation/math/matrix3';
import { Correspondence, localizationWeight } from './correspondence';

export function fitTranslation(
    points: readonly Correspondence[],
    indices: readonly number[],
): Mat3 | null {
    if (indices.length < 1) return null;
    let tx = 0;
    let ty = 0;
    let total = 0;
    for (const i of indices) {
        const weight = localizationWeight(points[i]);
        tx += weight * (points[i].dx - points[i].sx);
        ty += weight * (points[i].dy - points[i].sy);
        total += weight;
    }
    const m = mat3Identity();
    m[2] = tx / total;
    m[5] = ty / total;
    return m;
}
