import {
    bilinearTaps,
    createBilinearTaps,
    sampleBilinear,
} from '../../foundation/imaging/bilinear';

const KERNEL = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16];

export interface PyramidLevel {
    data: Float32Array;
    width: number;
    height: number;
}

function clamp(value: number, limit: number): number {
    return value < 0 ? 0 : value > limit ? limit : value;
}

function decimateAxis(level: PyramidLevel, alongX: boolean): PyramidLevel {
    const { data, width: sourceWidth, height: sourceHeight } = level;
    const width = alongX ? Math.max(1, sourceWidth >> 1) : sourceWidth;
    const height = alongX ? sourceHeight : Math.max(1, sourceHeight >> 1);
    const limit = (alongX ? sourceWidth : sourceHeight) - 1;
    const out = new Float32Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const center = Math.min(limit, (alongX ? x : y) * 2);
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            for (let k = -2; k <= 2; k++) {
                const weight = KERNEL[k + 2];
                const tap = clamp(center + k, limit);
                const index = (alongX ? y * sourceWidth + tap : tap * sourceWidth + x) * 4;
                r += data[index] * weight;
                g += data[index + 1] * weight;
                b += data[index + 2] * weight;
                a += data[index + 3] * weight;
            }
            const target = (y * width + x) * 4;
            out[target] = r;
            out[target + 1] = g;
            out[target + 2] = b;
            out[target + 3] = a;
        }
    }
    return { data: out, width, height };
}

export function reduceLevel(level: PyramidLevel): PyramidLevel {
    return decimateAxis(decimateAxis(level, true), false);
}

export function expandLevel(level: PyramidLevel, width: number, height: number): PyramidLevel {
    const upsampled = new Float32Array(width * height * 4);
    const scaleX = level.width / width;
    const scaleY = level.height / height;
    const taps = createBilinearTaps();
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            bilinearTaps(level.width, level.height, x * scaleX, y * scaleY, taps);
            const target = (y * width + x) * 4;
            for (let c = 0; c < 4; c++)
                upsampled[target + c] = sampleBilinear(level.data, taps, 4, c);
        }
    }
    return { data: upsampled, width, height };
}

export function canReduce(level: { width: number; height: number }): boolean {
    return level.width > 2 && level.height > 2;
}

export function gaussianPyramid(base: PyramidLevel, levels: number): PyramidLevel[] {
    const pyramid: PyramidLevel[] = [base];
    for (let level = 1; level < levels; level++) {
        const previous = pyramid[level - 1];
        if (!canReduce(previous)) {
            pyramid.push(previous);
            continue;
        }
        pyramid.push(reduceLevel(previous));
    }
    return pyramid;
}
