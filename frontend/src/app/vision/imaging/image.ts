export interface GrayImage {
    width: number;
    height: number;
    data: Float32Array;
}

export interface ColorImage {
    width: number;
    height: number;
    data: Uint8ClampedArray<ArrayBuffer>;
}

export function toGray(image: ColorImage): GrayImage {
    const { width, height, data } = image;
    const out = new Float32Array(width * height);
    for (let i = 0, p = 0; i < out.length; i++, p += 4) {
        out[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    }
    return { width, height, data: out };
}

export function sampleBilinear(
    data: Uint8ClampedArray,
    width: number,
    height: number,
    x: number,
    y: number,
    out: Float32Array,
): boolean {
    if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return false;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(width - 1, x0 + 1);
    const y1 = Math.min(height - 1, y0 + 1);
    const ax = x - x0;
    const ay = y - y0;
    const w00 = (1 - ax) * (1 - ay);
    const w10 = ax * (1 - ay);
    const w01 = (1 - ax) * ay;
    const w11 = ax * ay;
    const i00 = (y0 * width + x0) * 4;
    const i10 = (y0 * width + x1) * 4;
    const i01 = (y1 * width + x0) * 4;
    const i11 = (y1 * width + x1) * 4;
    for (let c = 0; c < 3; c++) {
        out[c] =
            data[i00 + c] * w00 + data[i10 + c] * w10 + data[i01 + c] * w01 + data[i11 + c] * w11;
    }
    return true;
}

export function sampleGrayBilinear(image: GrayImage, x: number, y: number): number {
    const { width, height, data } = image;
    const cx = Math.min(width - 1, Math.max(0, x));
    const cy = Math.min(height - 1, Math.max(0, y));
    const x0 = Math.floor(cx);
    const y0 = Math.floor(cy);
    const x1 = Math.min(width - 1, x0 + 1);
    const y1 = Math.min(height - 1, y0 + 1);
    const ax = cx - x0;
    const ay = cy - y0;
    const top = data[y0 * width + x0] * (1 - ax) + data[y0 * width + x1] * ax;
    const bottom = data[y1 * width + x0] * (1 - ax) + data[y1 * width + x1] * ax;
    return top * (1 - ay) + bottom * ay;
}
