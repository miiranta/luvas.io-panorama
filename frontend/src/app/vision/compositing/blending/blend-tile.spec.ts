import { cpuBlurBackend } from './blur-backend';
import { blendTile } from './blend-tile';
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

describe('blendTile', () => {
    it('binarizes the mask for average blending', () => {
        const mosaic = new CpuMosaic(8, 8, 2);
        const soft = tile(0.3);
        blendTile(mosaic, soft, 'average', cpuBlurBackend);
        expect(soft.mask[0]).toBe(1);
        expect(mosaic.flatWeight[0]).toBe(1);
    });

    it('keeps the feather mask as the flat weight', () => {
        const mosaic = new CpuMosaic(8, 8, 2);
        blendTile(mosaic, tile(0.3), 'feather', cpuBlurBackend);
        expect(mosaic.flatWeight[0]).toBeCloseTo(0.3, 6);
    });

    it('fills the pyramid bands for multiband blending', () => {
        const mosaic = new CpuMosaic(8, 8, 2);
        blendTile(mosaic, tile(1), 'multiband', cpuBlurBackend);
        expect(mosaic.bandWeight[0][0]).toBeGreaterThan(0);
        expect(mosaic.flatWeight[0]).toBe(1);
    });
});
