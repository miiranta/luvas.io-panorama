import { ModelKind } from '../../../core/models/params';

export interface Correspondence {
    sx: number;
    sy: number;
    dx: number;
    dy: number;
    sourceScale?: number;
    targetScale?: number;
}

export function localizationScale(point: Correspondence): number {
    return Math.max(1, point.sourceScale ?? 1, point.targetScale ?? 1);
}

export function localizationWeight(point: Correspondence): number {
    const scale = localizationScale(point);
    return 1 / (scale * scale);
}

export const MIN_PAIRS: Record<ModelKind, number> = {
    translation: 1,
    similarity: 2,
    affine: 3,
    homography: 4,
};
