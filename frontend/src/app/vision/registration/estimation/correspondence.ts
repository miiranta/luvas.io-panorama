import { ModelKind } from '../../../core/models/params';

export interface Correspondence {
    sx: number;
    sy: number;
    dx: number;
    dy: number;
    sourceScale?: number;
    targetScale?: number;
}

export const MIN_PAIRS: Record<ModelKind, number> = {
    translation: 1,
    similarity: 2,
    affine: 3,
    homography: 4,
};
