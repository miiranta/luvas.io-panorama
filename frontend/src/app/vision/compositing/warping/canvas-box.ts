export interface CanvasBox {
    u0: number;
    v0: number;
    u1: number;
    v1: number;
}

export const PYRAMID_ALIGNMENT = 64;

export function alignUp(value: number): number {
    return Math.ceil(value / PYRAMID_ALIGNMENT) * PYRAMID_ALIGNMENT;
}

export function alignDown(value: number): number {
    return Math.floor(value / PYRAMID_ALIGNMENT) * PYRAMID_ALIGNMENT;
}
