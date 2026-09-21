import { BlendKind, DEFAULT_PARAMS } from '../../../core/models/params';
import { SeamFinder } from '../seams/seam-finder';
import { WarpTile } from '../warping/warp-tile';
import { cpuBlurBackend } from './blur-backend';
import { blendTile, compositeMode } from './blend-tile';
import { CpuMosaic } from './cpu-mosaic';

function tile(mask: number) {
    return {
        u0: 0,
        v0: 0,
        width: 8,
        height: 8,
        color: new Float32Array(8 * 8 * 3).fill(90),
        mask: new Float32Array(64).fill(mask),
        pixels: 64,
    };
}

class ImageDataStub {
    constructor(
        readonly data: Uint8ClampedArray,
        readonly width: number,
        readonly height: number,
    ) {}
}

const SEAM_WIDTH = 360;
const SEAM_HEIGHT = 64;
const SEAM_PAD = 20;

function paddedTile(u0: number, width: number, value: number): WarpTile {
    const padded = width + 2 * SEAM_PAD;
    const mask = new Float32Array(padded * SEAM_HEIGHT);
    for (let y = 0; y < SEAM_HEIGHT; y++) {
        mask.fill(1, y * padded + SEAM_PAD, y * padded + SEAM_PAD + width);
    }
    return {
        u0: u0 - SEAM_PAD,
        v0: 0,
        width: padded,
        height: SEAM_HEIGHT,
        color: new Float32Array(padded * SEAM_HEIGHT * 3).fill(value),
        mask,
        pixels: width * SEAM_HEIGHT,
    };
}

function composeAcrossSeam(blend: BlendKind, layered: boolean): (u: number) => number {
    const params = { ...DEFAULT_PARAMS.compose, blend };
    const mode = compositeMode(params);
    const committed = new CpuMosaic(SEAM_WIDTH, SEAM_HEIGHT, params.bands);
    const preview = layered ? new CpuMosaic(SEAM_WIDTH, SEAM_HEIGHT, params.bands) : null;
    const old = paddedTile(20, 172, 50);
    new SeamFinder(params).cut(committed, old);
    blendTile(committed, old, blend, cpuBlurBackend, mode);
    const next = paddedTile(96, 224, 200);
    if (preview) new SeamFinder(params).cut(preview, next, committed);
    else new SeamFinder(params).cut(committed, next);
    blendTile(preview ?? committed, next, blend, cpuBlurBackend, mode);
    const image = committed.render(blend === 'multiband', preview, null, mode);
    return (u) => image.data[((SEAM_HEIGHT >> 1) * SEAM_WIDTH + u) * 4];
}

describe('blendTile', () => {
    beforeAll(() => {
        if (typeof ImageData === 'undefined')
            Object.assign(globalThis, { ImageData: ImageDataStub });
    });

    it('binarizes the mask for average blending', () => {
        const mosaic = new CpuMosaic(8, 8, 2);
        const soft = tile(0.3);
        blendTile(mosaic, soft, 'average', cpuBlurBackend, 'add');
        expect(soft.mask[0]).toBe(1);
        expect(mosaic.flatWeight[0]).toBe(1);
    });

    it('keeps the feather mask as the flat weight', () => {
        const mosaic = new CpuMosaic(8, 8, 2);
        blendTile(mosaic, tile(0.3), 'feather', cpuBlurBackend, 'add');
        expect(mosaic.flatWeight[0]).toBeCloseTo(0.3, 6);
    });

    it('fills the pyramid bands for multiband blending', () => {
        const mosaic = new CpuMosaic(8, 8, 2);
        blendTile(mosaic, tile(1), 'multiband', cpuBlurBackend, 'add');
        expect(mosaic.bandWeight[0][0]).toBeGreaterThan(0);
        expect(mosaic.flatWeight[0]).toBe(1);
    });

    it('composites over the mosaic only when seams pick the source', () => {
        expect(compositeMode({ ...DEFAULT_PARAMS.compose, seam: true })).toBe('over');
        expect(compositeMode({ ...DEFAULT_PARAMS.compose, seam: false })).toBe('add');
    });

    for (const blend of ['feather', 'multiband'] as const) {
        for (const layered of [false, true]) {
            it(`keeps one photo on each side of the seam (${blend}${layered ? ', live preview' : ''})`, () => {
                const at = composeAcrossSeam(blend, layered);
                expect(Math.abs(at(40) - 50)).toBeLessThanOrEqual(1);
                expect(Math.abs(at(105) - 50)).toBeLessThanOrEqual(2);
                expect(Math.abs(at(180) - 200)).toBeLessThanOrEqual(2);
                expect(Math.abs(at(300) - 200)).toBeLessThanOrEqual(1);
            });
        }
    }
});
