import { blurInterleaved } from '../imaging/filters';
import { Backend, BackendSelector, Calibration, RoutedBackend } from './backend-selector';
import { GlContext, GlTarget } from './gl-context';
import { SeparableBlur } from './separable-blur';

const CALIBRATION_SIDES = [96, 192, 384, 768];
const CALIBRATION_SIGMAS = [4, 8];
const AGREEMENT_TOLERANCE = 0.5;

export interface BlurBackend extends Backend {
    blurLevels(
        source: Float32Array,
        width: number,
        height: number,
        sigmas: readonly number[],
    ): Float32Array[] | null;
}

export const cpuBlurBackend: BlurBackend = {
    kind: 'cpu',
    blurLevels(source, width, height, sigmas) {
        const levels: Float32Array[] = [];
        let current = source;
        for (const sigma of sigmas) {
            current = blurInterleaved(current, width, height, sigma);
            levels.push(current);
        }
        return levels;
    },
};

class GpuBlurBackend implements BlurBackend {
    readonly kind = 'webgl2';
    private width = 0;
    private height = 0;
    private source: WebGLTexture | null = null;
    private targets: GlTarget[] = [];

    private constructor(
        private readonly context: GlContext,
        private readonly blur: SeparableBlur,
    ) {}

    static create(context: GlContext): GpuBlurBackend | null {
        if (!context.rendersFloat) return null;
        const blur = SeparableBlur.create(context);
        return blur ? new GpuBlurBackend(context, blur) : null;
    }

    blurLevels(
        source: Float32Array,
        width: number,
        height: number,
        sigmas: readonly number[],
    ): Float32Array[] | null {
        if (width < 1 || height < 1 || !this.allocate(width, height)) return null;
        const gl = this.context.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.source);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.FLOAT, source);
        const [scratch, even, odd] = this.targets;
        const levels: Float32Array[] = [];
        let input = this.source as WebGLTexture;
        sigmas.forEach((sigma, level) => {
            const output = level % 2 === 0 ? even : odd;
            this.blur.apply(input, sigma, scratch, output);
            const pixels = new Float32Array(width * height * 4);
            gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, pixels);
            levels.push(pixels);
            input = output.texture;
        });
        return this.context.finish() ? levels : null;
    }

    private allocate(width: number, height: number): boolean {
        if (this.width === width && this.height === height && this.targets.length === 3) {
            return true;
        }
        for (const target of this.targets) this.context.release(target);
        if (this.source) this.context.gl.deleteTexture(this.source);
        this.targets = [];
        this.width = 0;
        this.height = 0;
        this.source = this.context.floatTexture(width, height);
        if (!this.source) return false;
        for (let i = 0; i < 3; i++) {
            const target = this.context.target(
                this.context.floatTexture(width, height),
                width,
                height,
            );
            if (!target) return false;
            this.targets.push(target);
        }
        this.width = width;
        this.height = height;
        return true;
    }
}

class RoutedBlurBackend extends RoutedBackend<BlurBackend> implements BlurBackend {
    blurLevels(
        source: Float32Array,
        width: number,
        height: number,
        sigmas: readonly number[],
    ): Float32Array[] | null {
        return this.route(width * height, (backend) =>
            backend.blurLevels(source, width, height, sigmas),
        );
    }
}

function calibrationImage(side: number): Float32Array {
    const image = new Float32Array(side * side * 4);
    for (let i = 0; i < side * side; i++) {
        const value = ((i * 7919) % 251) / 251;
        image[i * 4] = value * 220;
        image[i * 4 + 1] = (1 - value) * 200;
        image[i * 4 + 2] = 120;
        image[i * 4 + 3] = 1;
    }
    return image;
}

const blurCalibration: Calibration<BlurBackend> = {
    cpu: cpuBlurBackend,
    workloads: CALIBRATION_SIDES.map((side) => side * side),
    createGpu: (context) => GpuBlurBackend.create(context),
    agrees(gpu, cpu, workload) {
        const side = Math.sqrt(workload);
        const image = calibrationImage(side);
        const expected = cpu.blurLevels(image, side, side, CALIBRATION_SIGMAS);
        const actual = gpu.blurLevels(image, side, side, CALIBRATION_SIGMAS);
        if (!expected || !actual) return false;
        return expected.every((level, index) => {
            let error = 0;
            for (let i = 0; i < level.length; i++) error += Math.abs(level[i] - actual[index][i]);
            return error / level.length < AGREEMENT_TOLERANCE;
        });
    },
    run(backend, workload) {
        const side = Math.sqrt(workload);
        return backend.blurLevels(calibrationImage(side), side, side, CALIBRATION_SIGMAS) !== null;
    },
    route: (gpu, cpu, threshold) => new RoutedBlurBackend(gpu, cpu, threshold),
    describeWorkload: (workload) => `${Math.sqrt(workload)}² px`,
};

export function createBlurSelector(): BackendSelector<BlurBackend> {
    return new BackendSelector(blurCalibration);
}
