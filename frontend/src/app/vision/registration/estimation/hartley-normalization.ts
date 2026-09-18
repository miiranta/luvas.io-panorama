import { mat3Identity } from '../../foundation/math/matrix3';
import { Correspondence } from './correspondence';

export function hartleyNormalization(
    points: readonly Correspondence[],
    indices: readonly number[],
    source: boolean,
) {
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
