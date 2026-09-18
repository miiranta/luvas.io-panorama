import { GrayImage } from './image';

function gaussianKernel(sigma: number): Float32Array {
    const radius = Math.max(1, Math.ceil(sigma * 3));
    const size = radius * 2 + 1;
    const kernel = new Float32Array(size);
    const denom = 2 * sigma * sigma;
    let sum = 0;
    for (let i = 0; i < size; i++) {
        const x = i - radius;
        const v = Math.exp(-(x * x) / denom);
        kernel[i] = v;
        sum += v;
    }
    for (let i = 0; i < size; i++) kernel[i] /= sum;
    return kernel;
}

function convolveRows(
    source: Float32Array,
    target: Float32Array,
    width: number,
    height: number,
    kernel: Float32Array,
): void {
    const radius = (kernel.length - 1) / 2;
    for (let y = 0; y < height; y++) {
        const row = y * width;
        for (let x = 0; x < width; x++) {
            let acc = 0;
            if (x >= radius && x < width - radius) {
                const base = row + x - radius;
                for (let k = 0; k < kernel.length; k++) acc += source[base + k] * kernel[k];
            } else {
                for (let k = -radius; k <= radius; k++) {
                    const sx = x + k < 0 ? 0 : x + k >= width ? width - 1 : x + k;
                    acc += source[row + sx] * kernel[k + radius];
                }
            }
            target[row + x] = acc;
        }
    }
}

function convolveColumns(
    source: Float32Array,
    target: Float32Array,
    width: number,
    height: number,
    kernel: Float32Array,
): void {
    const radius = (kernel.length - 1) / 2;
    target.fill(0);
    for (let y = 0; y < height; y++) {
        const out = y * width;
        for (let k = -radius; k <= radius; k++) {
            const sy = y + k < 0 ? 0 : y + k >= height ? height - 1 : y + k;
            const weight = kernel[k + radius];
            const input = sy * width;
            for (let x = 0; x < width; x++) target[out + x] += source[input + x] * weight;
        }
    }
}

export function blurGray(image: GrayImage, sigma: number): GrayImage {
    if (sigma <= 0.05) return { ...image, data: Float32Array.from(image.data) };
    const kernel = gaussianKernel(sigma);
    const { width, height, data } = image;
    const tmp = new Float32Array(width * height);
    const out = new Float32Array(width * height);
    convolveRows(data, tmp, width, height, kernel);
    convolveColumns(tmp, out, width, height, kernel);
    return { width, height, data: out };
}

export interface Gradients {
    ix: Float32Array;
    iy: Float32Array;
    magnitude: Float32Array;
}

export function sobelGradients(image: GrayImage): Gradients {
    const { width, height, data } = image;
    const ix = new Float32Array(width * height);
    const iy = new Float32Array(width * height);
    const magnitude = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
        const up = (y > 0 ? y - 1 : 0) * width;
        const mid = y * width;
        const down = (y < height - 1 ? y + 1 : height - 1) * width;
        for (let x = 0; x < width; x++) {
            const left = x > 0 ? x - 1 : 0;
            const right = x < width - 1 ? x + 1 : width - 1;
            const gx =
                -data[up + left] +
                data[up + right] -
                2 * data[mid + left] +
                2 * data[mid + right] -
                data[down + left] +
                data[down + right];
            const gy =
                -data[up + left] -
                2 * data[up + x] -
                data[up + right] +
                data[down + left] +
                2 * data[down + x] +
                data[down + right];
            const i = mid + x;
            const gxs = gx / 8;
            const gys = gy / 8;
            ix[i] = gxs;
            iy[i] = gys;
            magnitude[i] = Math.sqrt(gxs * gxs + gys * gys);
        }
    }
    return { ix, iy, magnitude };
}
