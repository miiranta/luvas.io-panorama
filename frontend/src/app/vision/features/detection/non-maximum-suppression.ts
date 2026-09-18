import { Keypoint } from './keypoint';
import { refineSubPixel } from './sub-pixel-refinement';

export interface SuppressionOptions {
    threshold: number;
    radius: number;
    border: number;
    subPixel: boolean;
}

function dilate(
    response: Float32Array,
    width: number,
    height: number,
    radius: number,
): Float32Array {
    const horizontal = new Float32Array(width * height);
    const out = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
        const row = y * width;
        for (let x = 0; x < width; x++) {
            let best = -Infinity;
            const from = Math.max(0, x - radius);
            const to = Math.min(width - 1, x + radius);
            for (let k = from; k <= to; k++) {
                const value = response[row + k];
                if (value > best) best = value;
            }
            horizontal[row + x] = best;
        }
    }
    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
            let best = -Infinity;
            const from = Math.max(0, y - radius);
            const to = Math.min(height - 1, y + radius);
            for (let k = from; k <= to; k++) {
                const value = horizontal[k * width + x];
                if (value > best) best = value;
            }
            out[y * width + x] = best;
        }
    }
    return out;
}

export function nonMaximumSuppression(
    response: Float32Array,
    width: number,
    height: number,
    options: SuppressionOptions,
): Keypoint[] {
    const { threshold, radius, border, subPixel } = options;
    const dilated = dilate(response, width, height, radius);
    const found: Keypoint[] = [];
    for (let y = border; y < height - border; y++) {
        for (let x = border; x < width - border; x++) {
            const i = y * width + x;
            const value = response[i];
            if (value <= threshold || dilated[i] > value) continue;
            const [px, py] = subPixel ? refineSubPixel(response, width, x, y) : [x, y];
            found.push({ x: px, y: py, response: value, orientation: 0, scale: 1 });
        }
    }
    return found;
}
