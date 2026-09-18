import { CpuMosaic } from './cpu-mosaic';
import { PyramidLevel, expandLevel, gaussianPyramid, reduceLevel } from './gaussian-pyramid';

function constant(width: number, height: number, value: number): PyramidLevel {
    const data = new Float32Array(width * height * 4);
    for (let i = 0; i < width * height; i++) data.set([value, value / 2, value / 4, 1], i * 4);
    return { data, width, height };
}

describe('blending', () => {
    it('halves the level and preserves a constant signal', () => {
        const reduced = reduceLevel(constant(33, 20, 80));
        expect([reduced.width, reduced.height]).toEqual([16, 10]);
        for (let i = 0; i < reduced.data.length; i += 4) expect(reduced.data[i]).toBeCloseTo(80, 4);
    });

    it('matches a direct 5×5 binomial filter followed by decimation', () => {
        const level: PyramidLevel = { data: new Float32Array(12 * 8 * 4), width: 12, height: 8 };
        for (let i = 0; i < level.data.length; i++) level.data[i] = (i * 37) % 101;
        const kernel = [1, 4, 6, 4, 1].map((k) => k / 16);
        const reduced = reduceLevel(level);
        const at = (x: number, y: number, c: number) =>
            level.data[(Math.min(7, Math.max(0, y)) * 12 + Math.min(11, Math.max(0, x))) * 4 + c];
        for (let y = 0; y < reduced.height; y++) {
            for (let x = 0; x < reduced.width; x++) {
                let expected = 0;
                for (let j = -2; j <= 2; j++)
                    for (let i = -2; i <= 2; i++)
                        expected += kernel[i + 2] * kernel[j + 2] * at(2 * x + i, 2 * y + j, 1);
                expect(reduced.data[(y * reduced.width + x) * 4 + 1]).toBeCloseTo(expected, 3);
            }
        }
    });

    it('expands back to the requested size', () => {
        const expanded = expandLevel(constant(8, 5, 40), 16, 10);
        expect(expanded.data.length).toBe(16 * 10 * 4);
        for (let i = 0; i < expanded.data.length; i += 4)
            expect(expanded.data[i]).toBeCloseTo(40, 4);
    });

    it('stops reducing tiny levels', () => {
        const pyramid = gaussianPyramid(constant(4, 4, 1), 5);
        expect(pyramid.map((level) => level.width)).toEqual([4, 2, 2, 2, 2]);
    });

    it('averages overlapping tiles and clears them again, including across the 360° seam', () => {
        const mosaic = new CpuMosaic(256, 32, 3, { u0: 0, v0: 0, canvasWidth: 256 });
        const tile = (u0: number, value: number) => ({
            u0,
            v0: 0,
            width: 100,
            height: 32,
            color: new Float32Array(100 * 32 * 3).fill(value),
            mask: new Float32Array(100 * 32).fill(1),
            pixels: 100 * 32,
        });
        mosaic.addFlat(tile(206, 100));
        mosaic.addFlat(tile(220, 200));
        const color = new Float32Array(3);
        expect(mosaic.meanColorAt(10 * 256 + 10, color)).toBe(true);
        expect(color[0]).toBeCloseTo(150, 4);
        mosaic.reset();
        expect(mosaic.flatWeight[10 * 256 + 10]).toBe(0);
        expect(mosaic.coverage[10 * 256 + 10]).toBe(0);
    });
});
