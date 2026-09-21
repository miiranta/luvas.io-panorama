import { DEFAULT_PARAMS } from '../../../core/models/params';
import { CpuMosaic } from '../blending/cpu-mosaic';
import { WarpTile } from '../warping/warp-tile';
import { SeamFinder } from './seam-finder';

const WIDTH = 360;
const HEIGHT = 120;
const PAD = 20;

const background = (u: number, v: number) => 90 + 60 * Math.sin(u * 0.21) * Math.cos(v * 0.17);
const inObject = (u: number, v: number) => u >= 150 && u < 190 && v >= 30 && v < 90;

function tile(u0: number, width: number, withObject: boolean): WarpTile {
    const padded = width + 2 * PAD;
    const color = new Float32Array(padded * HEIGHT * 3);
    const mask = new Float32Array(padded * HEIGHT);
    for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < padded; x++) {
            const u = u0 - PAD + x;
            const i = y * padded + x;
            color.fill(withObject && inObject(u, y) ? 240 : background(u, y), i * 3, i * 3 + 3);
            if (x >= PAD && x < PAD + width) mask[i] = 1;
        }
    }
    return {
        u0: u0 - PAD,
        v0: 0,
        width: padded,
        height: HEIGHT,
        color,
        mask,
        pixels: width * HEIGHT,
    };
}

function objectWeights(deghost: boolean): number[] {
    const params = { ...DEFAULT_PARAMS.compose, blend: 'feather' as const, deghost };
    const mosaic = new CpuMosaic(WIDTH, HEIGHT, params.bands);
    const old = tile(20, 200, false);
    new SeamFinder(params).cut(mosaic, old);
    mosaic.addFlat(old, 'over');
    const next = tile(120, 220, true);
    new SeamFinder(params).cut(mosaic, next);
    const weights: number[] = [];
    for (let v = 30; v < 90; v++) {
        for (let u = 150; u < 190; u++) weights.push(next.mask[v * next.width + u - next.u0]);
    }
    return weights;
}

describe('SeamFinder', () => {
    it('keeps a moving object out entirely when deghosting', () => {
        expect(Math.max(...objectWeights(true))).toBe(0);
    });

    it('never cuts through a moving object', () => {
        const weights = objectWeights(false);
        const inside = weights.filter((weight) => weight > 0.5).length;
        expect(inside === 0 || inside === weights.length).toBe(true);
    });
});
