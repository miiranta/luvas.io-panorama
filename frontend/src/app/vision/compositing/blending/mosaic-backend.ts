import { CpuMosaic } from './cpu-mosaic';
import { CompositeMode, MosaicSurface, MosaicView } from './mosaic-surface';
import { WarpTile } from '../warping/warp-tile';
import { cpuBlurBackend } from './blur-backend';
import {
    Backend,
    BackendSelector,
    Calibration,
    RoutedBackend,
} from '../../foundation/gpu/backend-selector';
import { GlContext } from '../../foundation/gpu/gl-context';
import { GpuMosaic } from './gpu-mosaic';

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

function compose(
    surface: MosaicSurface,
    overlay: MosaicSurface | null,
    tiles: readonly WarpTile[],
    mode: CompositeMode,
): number[] {
    const values: number[] = [];
    tiles.forEach((tile, index) => {
        const snapshot = surface.snapshot(tile, 4);
        for (let i = 0; i < snapshot.filled.length; i++) {
            values.push(snapshot.filled[i] ? snapshot.mean[i * 3] : -1);
        }
        const target = overlay && index === tiles.length - 1 ? overlay : surface;
        target.addPyramidBands(tile, cpuBlurBackend, mode);
    });
    for (const useBands of [true, false]) {
        const rendered = surface.render(useBands, overlay, null, mode).data;
        for (let i = 0; i < rendered.length; i++) values.push(rendered[i]);
    }
    return values;
}

function closeEnough(expected: readonly number[], actual: readonly number[]): boolean {
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

export interface MosaicMaker extends Backend {
    create(width: number, height: number, bands: number, view?: MosaicView): MosaicSurface | null;
}

export const cpuMosaicMaker: MosaicMaker = {
    kind: 'cpu',
    create: (width, height, bands, view) => new CpuMosaic(width, height, bands, view),
};

class GpuMosaicMaker implements MosaicMaker {
    readonly kind = 'webgl2';

    constructor(private readonly context: GlContext) {}

    create(width: number, height: number, bands: number, view?: MosaicView): MosaicSurface | null {
        return GpuMosaic.create(this.context, width, height, bands, view);
    }
}

class RoutedMosaicMaker extends RoutedBackend<MosaicMaker> implements MosaicMaker {
    create(width: number, height: number, bands: number, view?: MosaicView): MosaicSurface | null {
        return this.route(width * height, (maker) => maker.create(width, height, bands, view));
    }
}

interface ComposeVariant {
    mode: CompositeMode;
    layered: boolean;
}

const COMPOSE_VARIANTS: readonly ComposeVariant[] = [
    { mode: 'add', layered: false },
    { mode: 'over', layered: true },
];

interface AgreementCase {
    width: number;
    height: number;
    view?: MosaicView;
    tiles: () => WarpTile[];
}

const AGREEMENT_CASES: readonly AgreementCase[] = [
    {
        width: CHECK_WIDTH,
        height: CHECK_HEIGHT,
        tiles: () => [
            syntheticTile(0, 0, 256, 192, 0),
            syntheticTile(64, 64, 256, 192, 1),
            syntheticTile(128, 0, 256, 128, 2),
        ],
    },
    {
        width: WRAP_WIDTH,
        height: WRAP_HEIGHT,
        view: { u0: WRAP_CANVAS - 128, v0: 64, canvasWidth: WRAP_CANVAS },
        tiles: () => [
            syntheticTile(WRAP_CANVAS - 192, 64, 256, 192, 3),
            syntheticTile(-64, 128, 256, 128, 4),
        ],
    },
];

function composeWith(
    maker: MosaicMaker,
    width: number,
    height: number,
    tiles: readonly WarpTile[],
    variant: ComposeVariant,
    view?: MosaicView,
): number[] | null {
    const surface = maker.create(width, height, CHECK_BANDS, view);
    if (!surface) return null;
    const overlay = variant.layered ? maker.create(width, height, CHECK_BANDS, view) : null;
    const values =
        variant.layered && !overlay ? null : compose(surface, overlay, tiles, variant.mode);
    surface.dispose();
    overlay?.dispose();
    return values;
}

const mosaicCalibration: Calibration<MosaicMaker> = {
    cpu: cpuMosaicMaker,
    workloads: [TIMING_WIDTH * TIMING_HEIGHT],
    timingRuns: 1,
    createGpu: (context) => (context.blendsFloat ? new GpuMosaicMaker(context) : null),
    agrees(gpu, cpu) {
        return AGREEMENT_CASES.every(({ width, height, view, tiles }) =>
            COMPOSE_VARIANTS.every((variant) => {
                const expected = composeWith(cpu, width, height, tiles(), variant, view);
                const actual = composeWith(gpu, width, height, tiles(), variant, view);
                return expected !== null && actual !== null && closeEnough(expected, actual);
            }),
        );
    },
    run: (maker) =>
        composeWith(
            maker,
            TIMING_WIDTH,
            TIMING_HEIGHT,
            [syntheticTile(0, 0, 768, 576, 0), syntheticTile(384, 256, 768, 576, 1)],
            { mode: 'over', layered: false },
        ) !== null,
    route: (gpu, cpu, threshold) => new RoutedMosaicMaker(gpu, cpu, threshold),
    describeWorkload: () => `${TIMING_WIDTH}×${TIMING_HEIGHT}`,
};

export function createMosaicSelector(): BackendSelector<MosaicMaker> {
    return new BackendSelector(mosaicCalibration);
}
