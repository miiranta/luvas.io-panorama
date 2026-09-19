import { DetectParams } from '../../../core/models/params';
import { StructureTensorMaps, cornerMeasure, structureTensorMaps } from './structure-tensor';
import { GrayImage } from '../../foundation/imaging/image';
import {
    Backend,
    BackendSelector,
    Calibration,
    RoutedBackend,
} from '../../foundation/gpu/backend-selector';
import { GlContext, GlProgram, GlTarget } from '../../foundation/gpu/gl-context';
import { LruCache } from '../../foundation/cache/lru-cache';
import { SeparableBlur } from '../../foundation/gpu/separable-blur';

const CALIBRATION_SIZES: readonly [number, number][] = [
    [160, 120],
    [320, 240],
    [640, 480],
];
const PEAK_TOLERANCE = 0.05;
const MAX_ALLOCATIONS = 8;

interface DetectAllocation {
    source: WebGLTexture;
    targets: GlTarget[];
}
const MEAN_TOLERANCE = 0.01;

const GRADIENT = `#version 300 es
precision highp float;
uniform sampler2D uSource;
uniform vec2 uTexel;
in vec2 vUv;
out vec4 fragColor;
float luma(vec2 offset) {
    return texture(uSource, vUv + offset * uTexel).r;
}
void main() {
    float tl = luma(vec2(-1.0, -1.0));
    float tc = luma(vec2(0.0, -1.0));
    float tr = luma(vec2(1.0, -1.0));
    float ml = luma(vec2(-1.0, 0.0));
    float mr = luma(vec2(1.0, 0.0));
    float bl = luma(vec2(-1.0, 1.0));
    float bc = luma(vec2(0.0, 1.0));
    float br = luma(vec2(1.0, 1.0));
    float gx = (-tl + tr - 2.0 * ml + 2.0 * mr - bl + br) / 8.0;
    float gy = (-tl - 2.0 * tc - tr + bl + 2.0 * bc + br) / 8.0;
    fragColor = vec4(gx, gy, length(vec2(gx, gy)), 1.0);
}`;

const PRODUCTS = `#version 300 es
precision highp float;
uniform sampler2D uSource;
in vec2 vUv;
out vec4 fragColor;
void main() {
    vec4 g = texture(uSource, vUv);
    fragColor = vec4(g.x * g.x, g.y * g.y, g.x * g.y, 1.0);
}`;

const RESPONSE = `#version 300 es
precision highp float;
uniform sampler2D uSource;
uniform sampler2D uGradient;
uniform float uAlpha;
uniform int uShiTomasi;
in vec2 vUv;
out vec4 fragColor;
void main() {
    vec4 s = texture(uSource, vUv);
    float det = s.x * s.y - s.z * s.z;
    float trace = s.x + s.y;
    float value = uShiTomasi == 1
        ? (trace - sqrt(max(0.0, trace * trace - 4.0 * det))) * 0.5
        : det - uAlpha * trace * trace;
    fragColor = vec4(texture(uGradient, vUv).xyz, value);
}`;

export interface DetectBackend extends Backend {
    maps(image: GrayImage, params: DetectParams): StructureTensorMaps | null;
}

export const cpuDetectBackend: DetectBackend = {
    kind: 'cpu',
    maps: (image, params) => structureTensorMaps(image, params),
};

class GpuDetectBackend implements DetectBackend {
    readonly kind = 'webgl2';
    private readonly allocations = new LruCache<string, DetectAllocation>(
        MAX_ALLOCATIONS,
        (allocation) => this.release(allocation),
    );

    private constructor(
        private readonly context: GlContext,
        private readonly blur: SeparableBlur,
        private readonly gradient: GlProgram,
        private readonly products: GlProgram,
        private readonly response: GlProgram,
    ) {}

    static create(context: GlContext): GpuDetectBackend | null {
        if (!context.rendersFloat) return null;
        const blur = SeparableBlur.create(context);
        const gradient = context.program(GRADIENT, ['uSource', 'uTexel']);
        const products = context.program(PRODUCTS, ['uSource']);
        const response = context.program(RESPONSE, [
            'uSource',
            'uGradient',
            'uAlpha',
            'uShiTomasi',
        ]);
        if (!blur || !gradient || !products || !response) return null;
        return new GpuDetectBackend(context, blur, gradient, products, response);
    }

    maps(image: GrayImage, params: DetectParams): StructureTensorMaps | null {
        const { width, height } = image;
        const allocation = this.allocate(width, height);
        if (!allocation) return null;
        const gl = this.context.gl;

        gl.bindTexture(gl.TEXTURE_2D, allocation.source);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RED, gl.FLOAT, image.data);

        const [a, b, c, d] = allocation.targets;
        this.blur.apply(allocation.source, params.derivativeSigma, a, b);
        this.context.draw(this.gradient, d, width, height, () => {
            this.context.bindInput(0, b.texture, this.gradient.uniforms['uSource']);
            gl.uniform2f(this.gradient.uniforms['uTexel'], 1 / width, 1 / height);
        });
        this.context.draw(this.products, a, width, height, () => {
            this.context.bindInput(0, d.texture, this.products.uniforms['uSource']);
        });
        this.blur.apply(a.texture, params.integrationSigma, b, c);
        this.context.draw(this.response, a, width, height, () => {
            this.context.bindInput(0, c.texture, this.response.uniforms['uSource']);
            this.context.bindInput(1, d.texture, this.response.uniforms['uGradient']);
            gl.uniform1f(this.response.uniforms['uAlpha'], params.harrisAlpha);
            gl.uniform1i(
                this.response.uniforms['uShiTomasi'],
                cornerMeasure(params) === 'shi-tomasi' ? 1 : 0,
            );
        });
        const gradient = new Float32Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, gradient);
        if (!this.context.finish()) return null;
        const response = new Float32Array(width * height);
        for (let i = 0; i < response.length; i++) response[i] = gradient[i * 4 + 3];
        return { response, gradient };
    }

    private allocate(width: number, height: number): DetectAllocation | null {
        const key = `${width}x${height}`;
        const cached = this.allocations.get(key);
        if (cached) return cached;
        const source = this.context.redFloatTexture(width, height);
        if (!source) return null;
        const allocation: DetectAllocation = { source, targets: [] };
        for (let i = 0; i < 4; i++) {
            const target = this.context.target(
                this.context.floatTexture(width, height),
                width,
                height,
            );
            if (!target) {
                this.release(allocation);
                return null;
            }
            allocation.targets.push(target);
        }
        this.allocations.set(key, allocation);
        return allocation;
    }

    private release(allocation: DetectAllocation): void {
        this.context.gl.deleteTexture(allocation.source);
        for (const target of allocation.targets) this.context.release(target);
    }
}

class RoutedDetectBackend extends RoutedBackend<DetectBackend> implements DetectBackend {
    maps(image: GrayImage, params: DetectParams): StructureTensorMaps | null {
        return this.route(image.width * image.height, (backend) => backend.maps(image, params));
    }
}

function calibrationImage(workload: number): GrayImage {
    const [width, height] = CALIBRATION_SIZES.find(([w, h]) => w * h === workload) ?? [160, 120];
    const data = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const block = ((x >> 4) + (y >> 4)) % 2 === 0 ? 40 : 205;
            data[y * width + x] = block + ((x * 37 + y * 17) % 23);
        }
    }
    return { width, height, data };
}

export function createDetectSelector(params: () => DetectParams): BackendSelector<DetectBackend> {
    const calibration: Calibration<DetectBackend> = {
        cpu: cpuDetectBackend,
        workloads: CALIBRATION_SIZES.map(([width, height]) => width * height),
        createGpu: (context) => GpuDetectBackend.create(context),
        agrees(gpu, cpu, workload) {
            const image = calibrationImage(workload);
            const expected = cpu.maps(image, params());
            const actual = gpu.maps(image, params());
            if (!expected || !actual) return false;
            let peakExpected = 0;
            let peakActual = 0;
            let error = 0;
            for (let i = 0; i < expected.response.length; i++) {
                peakExpected = Math.max(peakExpected, Math.abs(expected.response[i]));
                peakActual = Math.max(peakActual, Math.abs(actual.response[i]));
                error += Math.abs(expected.response[i] - actual.response[i]);
            }
            if (peakExpected <= 0 || Math.abs(peakActual / peakExpected - 1) > PEAK_TOLERANCE) {
                return false;
            }
            return error / expected.response.length / peakExpected <= MEAN_TOLERANCE;
        },
        run: (backend, workload) => backend.maps(calibrationImage(workload), params()) !== null,
        route: (gpu, cpu, threshold) => new RoutedDetectBackend(gpu, cpu, threshold),
        describeWorkload(workload) {
            const size = CALIBRATION_SIZES.find(([w, h]) => w * h === workload);
            return size ? `${size[0]}×${size[1]}` : `${workload} px`;
        },
    };
    return new BackendSelector(calibration);
}
