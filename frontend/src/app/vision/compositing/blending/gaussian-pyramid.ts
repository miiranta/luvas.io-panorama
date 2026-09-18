const KERNEL = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16];

export interface PyramidLevel {
    data: Float32Array;
    width: number;
    height: number;
}

function clamp(value: number, limit: number): number {
    return value < 0 ? 0 : value > limit ? limit : value;
}

export function reduceLevel(level: PyramidLevel): PyramidLevel {
    const { data, width: sourceWidth, height: sourceHeight } = level;
    const width = Math.max(1, sourceWidth >> 1);
    const height = Math.max(1, sourceHeight >> 1);
    const horizontal = new Float32Array(width * sourceHeight * 4);
    for (let y = 0; y < sourceHeight; y++) {
        for (let x = 0; x < width; x++) {
            const sx = Math.min(sourceWidth - 1, x * 2);
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            for (let k = -2; k <= 2; k++) {
                const weight = KERNEL[k + 2];
                const index = (y * sourceWidth + clamp(sx + k, sourceWidth - 1)) * 4;
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
    const out = new Float32Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        const sy = Math.min(sourceHeight - 1, y * 2);
        for (let x = 0; x < width; x++) {
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            for (let k = -2; k <= 2; k++) {
                const weight = KERNEL[k + 2];
                const index = (clamp(sy + k, sourceHeight - 1) * width + x) * 4;
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
    return { data: out, width, height };
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
