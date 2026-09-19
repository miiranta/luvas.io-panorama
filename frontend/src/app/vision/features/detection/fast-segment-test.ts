import { DetectParams } from '../../../core/models/params';
import { GrayImage } from '../../foundation/imaging/image';

export const FAST_OFFSETS: readonly [number, number][] = [
    [0, -3],
    [1, -3],
    [2, -2],
    [3, -1],
    [3, 0],
    [3, 1],
    [2, 2],
    [1, 3],
    [0, 3],
    [-1, 3],
    [-2, 2],
    [-3, 1],
    [-3, 0],
    [-3, -1],
    [-2, -2],
    [-1, -3],
];

const COMPASS_STEPS = [0, 4, 8, 12];

export function fastSegmentTest(
    image: GrayImage,
    params: DetectParams,
    harris: Float32Array,
): Float32Array {
    const { width, height, data } = image;
    const response = new Float32Array(width * height);
    const threshold = params.fastThreshold;
    const arc = Math.max(9, Math.min(16, Math.round(params.fastArc)));
    const compass = Math.floor(arc / 4);
    const ring = new Int32Array(16);
    for (let i = 0; i < 16; i++) ring[i] = FAST_OFFSETS[i][1] * width + FAST_OFFSETS[i][0];
    for (let y = 3; y < height - 3; y++) {
        for (let x = 3; x < width - 3; x++) {
            const i = y * width + x;
            const center = data[i];
            const hi = center + threshold;
            const lo = center - threshold;
            let brighter = 0;
            let darker = 0;
            for (const step of COMPASS_STEPS) {
                const v = data[i + ring[step]];
                if (v > hi) brighter++;
                else if (v < lo) darker++;
            }
            if (brighter < compass && darker < compass) continue;
            let runBright = 0;
            let runDark = 0;
            let bestBright = 0;
            let bestDark = 0;
            for (let k = 0; k < 16 + arc; k++) {
                const v = data[i + ring[k % 16]];
                runBright = v > hi ? runBright + 1 : 0;
                runDark = v < lo ? runDark + 1 : 0;
                if (runBright > bestBright) bestBright = runBright;
                if (runDark > bestDark) bestDark = runDark;
            }
            if (bestBright >= arc || bestDark >= arc) response[i] = Math.max(1e-6, harris[i]);
        }
    }
    return response;
}
