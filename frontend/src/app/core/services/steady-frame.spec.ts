import { frameShift } from './steady-frame';

const WIDTH = 64;
const HEIGHT = 48;

function texture(offset: number): Float32Array {
    const gray = new Float32Array(WIDTH * HEIGHT);
    for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
            const u = x + offset;
            gray[y * WIDTH + x] =
                128 +
                50 * Math.sin(u * 0.7) * Math.cos(y * 0.55) +
                20 * Math.sin(u * 0.23 + y * 0.31);
        }
    }
    return gray;
}

describe('frameShift', () => {
    it('reads zero motion for identical frames', () => {
        expect(frameShift(texture(0), texture(0))).toBe(0);
    });

    it('grows with the camera motion between frames', () => {
        const small = frameShift(texture(0), texture(0.1));
        const large = frameShift(texture(0), texture(1));
        expect(small).toBeLessThan(0.12);
        expect(large).toBeGreaterThan(0.12);
        expect(large).toBeGreaterThan(small * 4);
    });

    it('does not divide by zero on a flat frame', () => {
        const flat = new Float32Array(WIDTH * HEIGHT).fill(90);
        expect(frameShift(flat, flat)).toBe(0);
    });
});
