import { ModelKind } from '../../../core/models/params';
import { Mat3 } from '../../foundation/math/matrix3';
import { Correspondence } from './correspondence';
import { fitAffine } from './fit-affine';
import { fitHomography } from './fit-homography';
import { fitSimilarity } from './fit-similarity';
import { fitTranslation } from './fit-translation';

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
