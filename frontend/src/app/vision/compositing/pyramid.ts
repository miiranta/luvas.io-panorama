const KERNEL = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16];

export interface PyramidLevel {
    data: Float32Array;
    width: number;
    height: number;
}

function clamp(value: number, limit: number): number {
    return value < 0 ? 0 : value > limit ? limit : value;
}

function blurRgba(level: PyramidLevel): Float32Array {
    const { data, width, height } = level;
    const horizontal = new Float32Array(data.length);
    const out = new Float32Array(data.length);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            for (let k = -2; k <= 2; k++) {
                const weight = KERNEL[k + 2];
                const index = (y * width + clamp(x + k, width - 1)) * 4;
                r += data[index] * weight;
                g += data[index + 1] * weight;
                b += data[index + 2] * weight;
                a += data[index + 3] * weight;
            }
            const target = (y * width + x) * 4;
            horizontal[target] = r;
            horizontal[target + 1] = g;
            horizontal[target + 2] = b;
            horizontal[target + 3] = a;
        }
    }
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            for (let k = -2; k <= 2; k++) {
                const weight = KERNEL[k + 2];
                const index = (clamp(y + k, height - 1) * width + x) * 4;
                r += horizontal[index] * weight;
                g += horizontal[index + 1] * weight;
                b += horizontal[index + 2] * weight;
                a += horizontal[index + 3] * weight;
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

export function reduceLevel(level: PyramidLevel): PyramidLevel {
    const blurred = blurRgba(level);
    const width = Math.max(1, level.width >> 1);
    const height = Math.max(1, level.height >> 1);
    const data = new Float32Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        const sy = Math.min(level.height - 1, y * 2);
        for (let x = 0; x < width; x++) {
            const sx = Math.min(level.width - 1, x * 2);
            const source = (sy * level.width + sx) * 4;
            const target = (y * width + x) * 4;
            data[target] = blurred[source];
            data[target + 1] = blurred[source + 1];
            data[target + 2] = blurred[source + 2];
            data[target + 3] = blurred[source + 3];
        }
    }
    return { data, width, height };
}

export function expandLevel(level: PyramidLevel, width: number, height: number): PyramidLevel {
    const upsampled = new Float32Array(width * height * 4);
    const scaleX = level.width / width;
    const scaleY = level.height / height;
    for (let y = 0; y < height; y++) {
        const fy = Math.min(level.height - 1, y * scaleY);
        const y0 = Math.floor(fy);
        const y1 = Math.min(level.height - 1, y0 + 1);
        const ay = fy - y0;
        for (let x = 0; x < width; x++) {
            const fx = Math.min(level.width - 1, x * scaleX);
            const x0 = Math.floor(fx);
            const x1 = Math.min(level.width - 1, x0 + 1);
            const ax = fx - x0;
            const i00 = (y0 * level.width + x0) * 4;
            const i10 = (y0 * level.width + x1) * 4;
            const i01 = (y1 * level.width + x0) * 4;
            const i11 = (y1 * level.width + x1) * 4;
            const w00 = (1 - ax) * (1 - ay);
            const w10 = ax * (1 - ay);
            const w01 = (1 - ax) * ay;
            const w11 = ax * ay;
            const target = (y * width + x) * 4;
            for (let c = 0; c < 4; c++) {
                upsampled[target + c] =
                    level.data[i00 + c] * w00 +
                    level.data[i10 + c] * w10 +
                    level.data[i01 + c] * w01 +
                    level.data[i11 + c] * w11;
            }
        }
    }
    return { data: upsampled, width, height };
}

export function gaussianPyramid(base: PyramidLevel, levels: number): PyramidLevel[] {
    const pyramid: PyramidLevel[] = [base];
    for (let level = 1; level < levels; level++) {
        const previous = pyramid[level - 1];
        if (previous.width <= 2 || previous.height <= 2) {
            pyramid.push(previous);
            continue;
        }
        pyramid.push(reduceLevel(previous));
    }
    return pyramid;
}
