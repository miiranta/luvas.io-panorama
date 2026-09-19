import { bicubicTaps, createBicubicTaps, sampleBicubic } from './bicubic';
import { bilinearTaps, createBilinearTaps, sampleBilinear } from './bilinear';
import { gaussianBlur } from './gaussian-blur';
import { grayPyramid } from './gray-pyramid';
import { GrayImage, imageCenter, sampleGrayBilinear, toGray } from './image';
import { sobelGradients } from './sobel-gradients';

function ramp(width: number, height: number, slope: number): GrayImage {
    const data = new Float32Array(width * height);
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) data[y * width + x] = x * slope;
    return { width, height, data };
}

describe('imaging', () => {
    it('places the image center between the middle pixels', () => {
        expect(imageCenter(640)).toBe(319.5);
        expect(imageCenter(5)).toBe(2);
    });

    it('converts color to luma', () => {
        const gray = toGray({
            width: 1,
            height: 1,
            data: new Uint8ClampedArray([100, 100, 100, 255]),
        });
        expect(gray.data[0]).toBeCloseTo(100, 4);
    });

    it('interpolates bilinearly and clamps at the border', () => {
        const image: GrayImage = { width: 2, height: 2, data: new Float32Array([0, 10, 20, 30]) };
        expect(sampleGrayBilinear(image, 0.5, 0.5)).toBeCloseTo(15, 6);
        expect(sampleGrayBilinear(image, -5, -5)).toBe(0);
        expect(sampleGrayBilinear(image, 9, 9)).toBe(30);
    });

    it('samples one channel of an interleaved buffer', () => {
        const data = new Float32Array([1, 100, 3, 300]);
        const taps = bilinearTaps(2, 1, 0.5, 0, createBilinearTaps());
        expect(sampleBilinear(data, taps, 2, 0)).toBeCloseTo(2, 6);
        expect(sampleBilinear(data, taps, 2, 1)).toBeCloseTo(200, 6);
    });

    it('interpolates bicubically through the samples and reproduces a quadratic', () => {
        const width = 8;
        const data = new Float32Array(width * 3);
        for (let y = 0; y < 3; y++)
            for (let x = 0; x < width; x++) data[y * width + x] = x * x + 5 * y;
        const taps = createBicubicTaps();
        expect(sampleBicubic(data, bicubicTaps(width, 3, 3, 1, taps), width)).toBeCloseTo(14, 9);
        expect(sampleBicubic(data, bicubicTaps(width, 3, 3.5, 1, taps), width)).toBeCloseTo(
            3.5 * 3.5 + 5,
            9,
        );
    });

    it('overshoots a step edge only slightly and clamps at the border', () => {
        const data = new Float32Array([0, 0, 0, 100, 100, 100]);
        const taps = createBicubicTaps();
        const near = sampleBicubic(data, bicubicTaps(6, 1, 3.25, 0, taps), 6);
        expect(near).toBeGreaterThan(100);
        expect(near).toBeLessThan(110);
        expect(sampleBicubic(data, bicubicTaps(6, 1, -4, 0, taps), 6)).toBe(0);
        expect(sampleBicubic(data, bicubicTaps(6, 1, 12, 0, taps), 6)).toBe(100);
    });

    it('keeps a constant image constant under Gaussian blur', () => {
        const flat: GrayImage = { width: 9, height: 7, data: new Float32Array(63).fill(42) };
        for (const value of gaussianBlur(flat, 1.6).data) expect(value).toBeCloseTo(42, 4);
    });

    it('measures the slope of a ramp with Sobel', () => {
        const { ix, iy } = sobelGradients(ramp(9, 9, 3));
        expect(ix[4 * 9 + 4]).toBeCloseTo(3, 6);
        expect(iy[4 * 9 + 4]).toBeCloseTo(0, 6);
    });

    it('builds a pyramid whose scales match the level sizes', () => {
        const levels = grayPyramid(ramp(240, 180, 1), 3, 1.5);
        expect(levels.map((level) => level.image.width)).toEqual([240, 160, 107]);
        expect(levels[1].scaleX).toBeCloseTo(1.5, 6);
    });
});
