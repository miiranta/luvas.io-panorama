import { bicubicTaps, createBicubicTaps, sampleBicubic } from '../../foundation/imaging/bicubic';
import {
    bilinearTaps,
    createBilinearTaps,
    sampleBilinear,
} from '../../foundation/imaging/bilinear';
import { ColorImage } from '../../foundation/imaging/image';

export interface MipLevel {
    width: number;
    height: number;
    data: Float32Array;
}

const cache = new WeakMap<ColorImage, MipLevel[]>();
const linearTaps = createBilinearTaps();
const cubicTaps = createBicubicTaps();

export function mipPyramidFor(image: ColorImage, maxLevels = 6): MipLevel[] {
    const cached = cache.get(image);
    if (cached) return cached;
    const levels = buildMipPyramid(image, maxLevels);
    cache.set(image, levels);
    return levels;
}

function buildMipPyramid(image: ColorImage, maxLevels = 6): MipLevel[] {
    const base = new Float32Array(image.width * image.height * 3);
    for (let i = 0, p = 0; i < image.width * image.height; i++, p += 4) {
        base[i * 3] = image.data[p];
        base[i * 3 + 1] = image.data[p + 1];
        base[i * 3 + 2] = image.data[p + 2];
    }
    const levels: MipLevel[] = [{ width: image.width, height: image.height, data: base }];
    while (levels.length < maxLevels) {
        const previous = levels[levels.length - 1];
        const width = previous.width >> 1;
        const height = previous.height >> 1;
        if (width < 2 || height < 2) break;
        const data = new Float32Array(width * height * 3);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i00 = (y * 2 * previous.width + x * 2) * 3;
                const i10 = (y * 2 * previous.width + x * 2 + 1) * 3;
                const i01 = ((y * 2 + 1) * previous.width + x * 2) * 3;
                const i11 = ((y * 2 + 1) * previous.width + x * 2 + 1) * 3;
                const target = (y * width + x) * 3;
                for (let c = 0; c < 3; c++) {
                    data[target + c] =
                        (previous.data[i00 + c] +
                            previous.data[i10 + c] +
                            previous.data[i01 + c] +
                            previous.data[i11 + c]) /
                        4;
                }
            }
        }
        levels.push({ width, height, data });
    }
    return levels;
}

function sampleFinest(level: MipLevel, x: number, y: number, out: Float32Array): void {
    bicubicTaps(level.width, level.height, x, y, cubicTaps);
    for (let c = 0; c < 3; c++) out[c] = sampleBicubic(level.data, cubicTaps, level.width, 3, c);
}

function sampleCoarse(level: MipLevel, x: number, y: number, out: Float32Array): void {
    bilinearTaps(level.width, level.height, x, y, linearTaps);
    for (let c = 0; c < 3; c++) out[c] = sampleBilinear(level.data, linearTaps, 3, c);
}

export function sampleMipmapped(
    levels: readonly MipLevel[],
    x: number,
    y: number,
    lod: number,
    out: Float32Array,
    scratch: Float32Array,
): void {
    const clamped = Math.min(levels.length - 1, Math.max(0, lod));
    const low = clamped | 0;
    const high = Math.min(levels.length - 1, low + 1);
    sampleScaled(levels, low, x, y, out);
    const blend = clamped - low;
    if (blend <= 1e-3 || high === low) return;
    sampleScaled(levels, high, x, y, scratch);
    for (let c = 0; c < 3; c++) out[c] += (scratch[c] - out[c]) * blend;
}

function sampleScaled(
    levels: readonly MipLevel[],
    index: number,
    x: number,
    y: number,
    out: Float32Array,
): void {
    if (index === 0) {
        sampleFinest(levels[0], x, y, out);
        return;
    }
    const level = levels[index];
    const scaleX = level.width / levels[0].width;
    const scaleY = level.height / levels[0].height;
    sampleCoarse(level, (x + 0.5) * scaleX - 0.5, (y + 0.5) * scaleY - 0.5, out);
}
