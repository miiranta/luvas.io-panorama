import { Mat3, mat3Identity } from '../../foundation/math/matrix3';
import { Correspondence } from './correspondence';

export function fitTranslation(
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
