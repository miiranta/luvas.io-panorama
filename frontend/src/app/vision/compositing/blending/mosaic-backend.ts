import { CpuMosaic } from './cpu-mosaic';
import { MosaicFactory, MosaicSurface, MosaicView } from './mosaic-surface';
import { WarpTile } from '../warping/warp-tile';
import { cpuBlurBackend } from './blur-backend';
import { describeBackend } from '../../foundation/gpu/backend-selector';
import { GlContext } from '../../foundation/gpu/gl-context';
import { GpuMosaic } from './gpu-mosaic';

const REQUIRED_SPEEDUP = 0.85;
const AGREEMENT_MEAN = 0.75;
const AGREEMENT_MAX = 6;
const CHECK_WIDTH = 384;
const CHECK_HEIGHT = 256;
const CHECK_BANDS = 4;
const TIMING_WIDTH = 1536;
const WRAP_CANVAS = 1024;
const WRAP_WIDTH = 384;
const WRAP_HEIGHT = 320;
const TIMING_HEIGHT = 1024;

interface Verdict {
    gpu: boolean;
    reason: string;
    gpuMs: number | null;
    cpuMs: number | null;
}

function syntheticTile(
    u0: number,
    v0: number,
    width: number,
    height: number,
    seed: number,
): WarpTile {
    const color = new Float32Array(width * height * 3);
    const mask = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            const block = ((((x + u0) >> 4) + ((y + v0) >> 4) + seed) % 3) * 70;
            color[i * 3] = (block + x * 0.4) % 255;
            color[i * 3 + 1] = (block + y * 0.6 + seed * 30) % 255;
            color[i * 3 + 2] = (120 + seed * 40 + ((x * y) % 37)) % 255;
            const edge = Math.min(x, y, width - 1 - x, height - 1 - y);
            mask[i] = Math.min(1, (edge + 0.5) / 24);
        }
    }
    return { u0, v0, width, height, color, mask, pixels: width * height };
}

function compose(surface: MosaicSurface, tiles: readonly WarpTile[]): number[] {
    const values: number[] = [];
    for (const tile of tiles) {
        const snapshot = surface.snapshot(tile, 4);
        for (let i = 0; i < snapshot.filled.length; i++) {
            values.push(snapshot.filled[i] ? snapshot.mean[i * 3] : -1);
        }
        surface.addPyramidBands(tile, cpuBlurBackend);
    }
    const rendered = surface.render(true, null, null).data;
    for (let i = 0; i < rendered.length; i++) values.push(rendered[i]);
    return values;
}

function agrees(expected: readonly number[], actual: readonly number[]): boolean {
    if (expected.length !== actual.length) return false;
    let total = 0;
    let worst = 0;
    for (let i = 0; i < expected.length; i++) {
        const difference = Math.abs(expected[i] - actual[i]);
        total += difference;
        if (difference > worst) worst = difference;
    }
    return total / expected.length <= AGREEMENT_MEAN && worst <= AGREEMENT_MAX;
}

export class MosaicBackend {
    private verdict: Verdict | null = null;

    factory(enabled: boolean): MosaicFactory {
        const useGpu = enabled && this.decide().gpu;
        return (width: number, height: number, bands: number, view?: MosaicView) => {
            if (useGpu) {
                const context = GlContext.shared();
                const gpu = context ? GpuMosaic.create(context, width, height, bands, view) : null;
                if (gpu) return gpu;
            }
            return new CpuMosaic(width, height, bands, view);
        };
    }

    describe(enabled: boolean): string {
        if (!enabled) return 'cpu (disabled)';
        const { gpu, reason, gpuMs, cpuMs } = this.decide();
        return describeBackend(gpu ? 'webgl2' : 'cpu', reason, gpuMs, cpuMs);
    }

    private decide(): Verdict {
        if (!this.verdict) {
            try {
                this.verdict = this.calibrate();
            } catch {
                this.verdict = {
                    gpu: false,
                    reason: 'calibration failed',
                    gpuMs: null,
                    cpuMs: null,
                };
            }
        }
        return this.verdict;
    }

    private calibrate(): Verdict {
        const fallback = (reason: string): Verdict => ({
            gpu: false,
            reason,
            gpuMs: null,
            cpuMs: null,
        });
        const context = GlContext.shared();
        if (!context) return fallback('no webgl2');
        if (context.isSoftware) return fallback('software gl');
        if (!context.blendsFloat) return fallback('no float blending');
        const checkTiles = [
            syntheticTile(0, 0, 256, 192, 0),
            syntheticTile(64, 64, 256, 192, 1),
            syntheticTile(128, 0, 256, 128, 2),
        ];
        const gpuCheck = GpuMosaic.create(context, CHECK_WIDTH, CHECK_HEIGHT, CHECK_BANDS);
        if (!gpuCheck) return fallback('incomplete webgl2');
        const expected = compose(new CpuMosaic(CHECK_WIDTH, CHECK_HEIGHT, CHECK_BANDS), checkTiles);
        const actual = compose(gpuCheck, checkTiles);
        gpuCheck.dispose();
        if (!agrees(expected, actual)) return fallback('gpu/cpu mismatch');
        const view = { u0: WRAP_CANVAS - 128, v0: 64, canvasWidth: WRAP_CANVAS };
        const wrapTiles = [
            syntheticTile(WRAP_CANVAS - 192, 64, 256, 192, 3),
            syntheticTile(-64, 128, 256, 128, 4),
        ];
        const gpuWrap = GpuMosaic.create(context, WRAP_WIDTH, WRAP_HEIGHT, CHECK_BANDS, view);
        if (!gpuWrap) return fallback('incomplete webgl2');
        const expectedWrap = compose(
            new CpuMosaic(WRAP_WIDTH, WRAP_HEIGHT, CHECK_BANDS, view),
            wrapTiles,
        );
        const actualWrap = compose(gpuWrap, wrapTiles);
        gpuWrap.dispose();
        if (!agrees(expectedWrap, actualWrap)) return fallback('gpu/cpu mismatch across the wrap');
        const timingTiles = [
            syntheticTile(0, 0, 768, 576, 0),
            syntheticTile(384, 256, 768, 576, 1),
        ];
        const time = (create: () => MosaicSurface | null): number | null => {
            const surface = create();
            if (!surface) return null;
            const started = performance.now();
            compose(surface, timingTiles);
            const elapsed = performance.now() - started;
            surface.dispose();
            return elapsed;
        };
        const cpuMs = time(() => new CpuMosaic(TIMING_WIDTH, TIMING_HEIGHT, CHECK_BANDS));
        const gpuMs = time(() =>
            GpuMosaic.create(context, TIMING_WIDTH, TIMING_HEIGHT, CHECK_BANDS),
        );
        if (cpuMs === null || gpuMs === null) return fallback('measurement failed');
        const gpu = gpuMs < cpuMs * REQUIRED_SPEEDUP;
        return { gpu, reason: gpu ? 'gpu faster' : 'cpu faster', gpuMs, cpuMs };
    }
}
