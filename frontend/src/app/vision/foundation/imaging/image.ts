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
