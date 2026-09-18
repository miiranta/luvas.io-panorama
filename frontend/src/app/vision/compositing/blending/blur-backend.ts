import { PyramidLevel, canReduce, gaussianPyramid } from './gaussian-pyramid';
import {
    Backend,
    BackendSelector,
    Calibration,
    RoutedBackend,
} from '../../foundation/gpu/backend-selector';
import { GlContext, GlProgram, GlTarget, growTarget } from '../../foundation/gpu/gl-context';

const CALIBRATION_SIDES = [128, 256, 512];
const CALIBRATION_LEVELS = 4;
const AGREEMENT_TOLERANCE = 0.75;

export interface BlurBackend extends Backend {
    reduceLevels(base: PyramidLevel, levels: number): PyramidLevel[] | null;
}

export const REDUCE_SHADER = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSource;
uniform ivec2 uSourceSize;
out vec4 fragColor;

const float kernel[5] = float[5](0.0625, 0.25, 0.375, 0.25, 0.0625);

void main() {
    ivec2 base = ivec2(gl_FragCoord.xy) * 2;
    vec4 total = vec4(0.0);
    for (int j = -2; j <= 2; j++) {
        for (int i = -2; i <= 2; i++) {
            ivec2 coord = clamp(base + ivec2(i, j), ivec2(0), uSourceSize - 1);
            total += texelFetch(uSource, coord, 0) * (kernel[i + 2] * kernel[j + 2]);
        }
    }
    fragColor = total;
}`;

export const cpuBlurBackend: BlurBackend = {
    kind: 'cpu',
    reduceLevels(base: PyramidLevel, levels: number): PyramidLevel[] {
        return gaussianPyramid(base, levels);
    },
};

class GpuBlurBackend implements BlurBackend {
    readonly kind = 'webgl2';
    private source: WebGLTexture | null = null;
    private sourceWidth = 0;
    private sourceHeight = 0;
    private targets: (GlTarget | null)[] = [];

    private constructor(
        private readonly context: GlContext,
        private readonly program: GlProgram,
    ) {}

    static create(context: GlContext): GpuBlurBackend | null {
        if (!context.rendersFloat) return null;
        const program = context.program(REDUCE_SHADER, ['uSource', 'uSourceSize']);
        return program ? new GpuBlurBackend(context, program) : null;
    }

    reduceLevels(base: PyramidLevel, levels: number): PyramidLevel[] | null {
        if (levels <= 1) return [base];
        if (!this.allocateSource(base.width, base.height)) return null;
        const gl = this.context.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.source);
        gl.texSubImage2D(
            gl.TEXTURE_2D,
            0,
            0,
            0,
            base.width,
            base.height,
            gl.RGBA,
            gl.FLOAT,
            base.data,
        );
        const pyramid: PyramidLevel[] = [base];
        let inputTexture = this.source as WebGLTexture;
        let inputWidth = base.width;
        let inputHeight = base.height;
        for (let level = 1; level < levels; level++) {
            const previous = pyramid[level - 1];
            if (!canReduce(previous)) {
                pyramid.push(previous);
                continue;
            }
            const width = Math.max(1, previous.width >> 1);
            const height = Math.max(1, previous.height >> 1);
            const target = this.targetFor(level - 1, width, height);
            if (!target) return null;
            const uniforms = this.program.uniforms;
            this.context.draw(this.program, target, width, height, () => {
                this.context.bindInput(0, inputTexture, uniforms['uSource']);
                gl.uniform2i(uniforms['uSourceSize'], inputWidth, inputHeight);
            });
            const data = new Float32Array(width * height * 4);
            gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, data);
            pyramid.push({ data, width, height });
            inputTexture = target.texture;
            inputWidth = width;
            inputHeight = height;
        }
        return this.context.finish() ? pyramid : null;
    }

    private allocateSource(width: number, height: number): boolean {
        if (this.source && this.sourceWidth >= width && this.sourceHeight >= height) return true;
        if (this.source) this.context.gl.deleteTexture(this.source);
        const grownWidth = Math.max(width, this.sourceWidth);
        const grownHeight = Math.max(height, this.sourceHeight);
        this.source = this.context.floatTexture(grownWidth, grownHeight);
        if (!this.source) {
            this.sourceWidth = 0;
            this.sourceHeight = 0;
            return false;
        }
        this.sourceWidth = grownWidth;
        this.sourceHeight = grownHeight;
        return true;
    }

    private targetFor(slot: number, width: number, height: number): GlTarget | null {
        const target = growTarget(this.context, this.targets[slot] ?? null, width, height, 'float');
        this.targets[slot] = target;
        return target;
    }
}

class RoutedBlurBackend extends RoutedBackend<BlurBackend> implements BlurBackend {
    reduceLevels(base: PyramidLevel, levels: number): PyramidLevel[] | null {
        return this.route(base.width * base.height, (backend) =>
            backend.reduceLevels(base, levels),
        );
    }
}

function calibrationLevel(side: number): PyramidLevel {
    const data = new Float32Array(side * side * 4);
    for (let i = 0; i < side * side; i++) {
        const value = ((i * 7919) % 251) / 251;
        data[i * 4] = value * 220;
        data[i * 4 + 1] = (1 - value) * 200;
        data[i * 4 + 2] = 120;
        data[i * 4 + 3] = 0.25 + 0.75 * value;
    }
    return { data, width: side, height: side };
}

const blurCalibration: Calibration<BlurBackend> = {
    cpu: cpuBlurBackend,
    workloads: CALIBRATION_SIDES.map((side) => side * side),
    createGpu: (context) => GpuBlurBackend.create(context),
    agrees(gpu, cpu, workload) {
        const side = Math.round(Math.sqrt(workload));
        const base = calibrationLevel(side);
        const expected = cpu.reduceLevels(base, CALIBRATION_LEVELS);
        const actual = gpu.reduceLevels(base, CALIBRATION_LEVELS);
        if (!expected || !actual || expected.length !== actual.length) return false;
        return expected.every((level, index) => {
            const other = actual[index];
            if (level.width !== other.width || level.height !== other.height) return false;
            let error = 0;
            for (let i = 0; i < level.data.length; i++) {
                error += Math.abs(level.data[i] - other.data[i]);
            }
            return error / level.data.length < AGREEMENT_TOLERANCE;
        });
    },
    run(backend, workload) {
        const side = Math.round(Math.sqrt(workload));
        return backend.reduceLevels(calibrationLevel(side), CALIBRATION_LEVELS) !== null;
    },
    route: (gpu, cpu, threshold) => new RoutedBlurBackend(gpu, cpu, threshold),
    describeWorkload: (workload) => `${Math.round(Math.sqrt(workload))}² px`,
};

export function createBlurSelector(): BackendSelector<BlurBackend> {
    return new BackendSelector(blurCalibration);
}
