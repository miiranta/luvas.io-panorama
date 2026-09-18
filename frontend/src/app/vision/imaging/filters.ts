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

export function blurGray(image: GrayImage, sigma: number): GrayImage {
    if (sigma <= 0.05) return { ...image, data: Float32Array.from(image.data) };
    const kernel = gaussianKernel(sigma);
    const radius = (kernel.length - 1) / 2;
    const { width, height, data } = image;
    const tmp = new Float32Array(width * height);
    const out = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
        const row = y * width;
        for (let x = 0; x < width; x++) {
            let acc = 0;
            for (let k = -radius; k <= radius; k++) {
                const sx = Math.min(width - 1, Math.max(0, x + k));
                acc += data[row + sx] * kernel[k + radius];
            }
            tmp[row + x] = acc;
        }
    }
    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
            let acc = 0;
            for (let k = -radius; k <= radius; k++) {
                const sy = Math.min(height - 1, Math.max(0, y + k));
                acc += tmp[sy * width + x] * kernel[k + radius];
            }
            out[y * width + x] = acc;
        }
    }
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
    const at = (x: number, y: number) =>
        data[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))];
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const gx =
                -at(x - 1, y - 1) +
                at(x + 1, y - 1) -
                2 * at(x - 1, y) +
                2 * at(x + 1, y) -
                at(x - 1, y + 1) +
                at(x + 1, y + 1);
            const gy =
                -at(x - 1, y - 1) -
                2 * at(x, y - 1) -
                at(x + 1, y - 1) +
                at(x - 1, y + 1) +
                2 * at(x, y + 1) +
                at(x + 1, y + 1);
            const i = y * width + x;
            ix[i] = gx / 8;
            iy[i] = gy / 8;
            magnitude[i] = Math.hypot(ix[i], iy[i]);
        }
    }
    return { ix, iy, magnitude };
}

export function blurInterleaved(
    source: Float32Array,
    width: number,
    height: number,
    sigma: number,
): Float32Array {
    const radius = Math.max(1, Math.ceil(sigma * 3));
    const size = radius * 2 + 1;
    const kernel = new Float32Array(size);
    const denom = 2 * sigma * sigma;
    let sum = 0;
    for (let i = 0; i < size; i++) {
        const x = i - radius;
        const value = Math.exp(-(x * x) / denom);
        kernel[i] = value;
        sum += value;
    }
    for (let i = 0; i < size; i++) kernel[i] /= sum;
    const tmp = new Float32Array(source.length);
    const out = new Float32Array(source.length);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            for (let k = -radius; k <= radius; k++) {
                const sx = Math.min(width - 1, Math.max(0, x + k));
                const index = (y * width + sx) * 4;
                const weight = kernel[k + radius];
                r += source[index] * weight;
                g += source[index + 1] * weight;
                b += source[index + 2] * weight;
                a += source[index + 3] * weight;
            }
            const target = (y * width + x) * 4;
            tmp[target] = r;
            tmp[target + 1] = g;
            tmp[target + 2] = b;
            tmp[target + 3] = a;
        }
    }
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            for (let k = -radius; k <= radius; k++) {
                const sy = Math.min(height - 1, Math.max(0, y + k));
                const index = (sy * width + x) * 4;
                const weight = kernel[k + radius];
                r += tmp[index] * weight;
                g += tmp[index + 1] * weight;
                b += tmp[index + 2] * weight;
                a += tmp[index + 3] * weight;
            }
            const target = (y * width + x) * 4;
            out[target] = r;
            out[target + 1] = g;
            out[target + 2] = b;
            out[target + 3] = a;
        }
    }
    return out;
}
