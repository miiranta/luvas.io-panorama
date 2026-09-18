import { Keypoint } from './keypoint';
import { refineSubPixel } from './sub-pixel-refinement';

export interface SuppressionOptions {
    threshold: number;
    radius: number;
    border: number;
    subPixel: boolean;
}

function isLocalMaximum(
    response: Float32Array,
    width: number,
    height: number,
    x: number,
    y: number,
    radius: number,
): boolean {
    const index = y * width + x;
    const value = response[index];
    if (
        response[index - 1] > value ||
        response[index + 1] > value ||
        response[index - width] > value ||
        response[index + width] > value
    ) {
        return false;
    }
    const x0 = Math.max(0, x - radius);
    const x1 = Math.min(width - 1, x + radius);
    const y1 = Math.min(height - 1, y + radius);
    for (let row = Math.max(0, y - radius); row <= y1; row++) {
        const start = row * width;
        for (let column = x0; column <= x1; column++) {
            if (response[start + column] > value) return false;
        }
    }
    return true;
}

export function nonMaximumSuppression(
    response: Float32Array,
    width: number,
    height: number,
    options: SuppressionOptions,
): Keypoint[] {
    const { threshold, radius, border, subPixel } = options;
    const found: Keypoint[] = [];
    for (let y = border; y < height - border; y++) {
        for (let x = border; x < width - border; x++) {
            const i = y * width + x;
            const value = response[i];
            if (value <= threshold || !isLocalMaximum(response, width, height, x, y, radius)) {
                continue;
            }
            const [px, py] = subPixel ? refineSubPixel(response, width, x, y) : [x, y];
            found.push({ x: px, y: py, response: value, orientation: 0, scale: 1 });
        }
    }
    return found;
}
