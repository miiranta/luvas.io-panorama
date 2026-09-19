import { bilinearTaps, createBilinearTaps, sampleBilinear } from './bilinear';

const taps = createBilinearTaps();

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

export function luma(red: number, green: number, blue: number): number {
    return 0.299 * red + 0.587 * green + 0.114 * blue;
}

export function toGray(image: ColorImage): GrayImage {
    const { width, height, data } = image;
    const out = new Float32Array(width * height);
    for (let i = 0, p = 0; i < out.length; i++, p += 4) {
        out[i] = luma(data[p], data[p + 1], data[p + 2]);
    }
    return { width, height, data: out };
}

export function sampleGrayBilinear(image: GrayImage, x: number, y: number): number {
    return sampleBilinear(image.data, bilinearTaps(image.width, image.height, x, y, taps));
}

export function imageCenter(size: number): number {
    return (size - 1) / 2;
}
