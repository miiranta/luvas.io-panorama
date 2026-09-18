import { GrayImage } from './image';

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
