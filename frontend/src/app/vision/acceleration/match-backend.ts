import { DESCRIPTOR_WORDS, hammingDistance } from '../features/brief-descriptor';
import { Backend, BackendSelector, Calibration, RoutedBackend } from './backend-selector';
import { GlContext, GlProgram, GlTarget } from './gl-context';

const CALIBRATION_COUNTS = [100, 300, 900];
const NO_DISTANCE = 4096;

const NEAREST = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D uQuery;
uniform usampler2D uTrain;
uniform int uTrainCount;
out uvec4 fragColor;

uint popcount(uint value) {
    uint v = value - ((value >> 1u) & 0x55555555u);
    v = (v & 0x33333333u) + ((v >> 2u) & 0x33333333u);
    v = (v + (v >> 4u)) & 0x0F0F0F0Fu;
    return (v * 0x01010101u) >> 24u;
}

uint distance8(uvec4 a0, uvec4 a1, uvec4 b0, uvec4 b1) {
    uvec4 x0 = a0 ^ b0;
    uvec4 x1 = a1 ^ b1;
    return popcount(x0.x) + popcount(x0.y) + popcount(x0.z) + popcount(x0.w) +
        popcount(x1.x) + popcount(x1.y) + popcount(x1.z) + popcount(x1.w);
}

void main() {
    int query = int(gl_FragCoord.x);
    uvec4 a0 = texelFetch(uQuery, ivec2(0, query), 0);
    uvec4 a1 = texelFetch(uQuery, ivec2(1, query), 0);
    uint best = ${NO_DISTANCE}u;
    uint second = ${NO_DISTANCE}u;
    uint bestIndex = 0u;
    for (int train = 0; train < uTrainCount; train++) {
        uint d = distance8(
            a0,
            a1,
            texelFetch(uTrain, ivec2(0, train), 0),
            texelFetch(uTrain, ivec2(1, train), 0)
        );
        if (d < best) {
            second = best;
            best = d;
            bestIndex = uint(train);
        } else if (d < second) {
            second = d;
        }
    }
    fragColor = uvec4(bestIndex, best, second, 0u);
}`;

export interface NearestNeighbours {
    index: Int32Array;
    best: Uint32Array;
    second: Uint32Array;
}

export interface MatchBackend extends Backend {
    nearest(
        query: Uint32Array,
        queryCount: number,
        train: Uint32Array,
        trainCount: number,
    ): NearestNeighbours | null;
}

export const cpuMatchBackend: MatchBackend = {
    kind: 'cpu',
    nearest(query, queryCount, train, trainCount) {
        const index = new Int32Array(queryCount).fill(-1);
        const best = new Uint32Array(queryCount).fill(NO_DISTANCE);
        const second = new Uint32Array(queryCount).fill(NO_DISTANCE);
        for (let q = 0; q < queryCount; q++) {
            const offset = q * DESCRIPTOR_WORDS;
            for (let t = 0; t < trainCount; t++) {
                const d = hammingDistance(query, offset, train, t * DESCRIPTOR_WORDS);
                if (d < best[q]) {
                    second[q] = best[q];
                    best[q] = d;
                    index[q] = t;
                } else if (d < second[q]) {
                    second[q] = d;
                }
            }
        }
        return { index, best, second };
    },
};

interface DescriptorTexture {
    texture: WebGLTexture;
    rows: number;
}

class GpuMatchBackend implements MatchBackend {
    readonly kind = 'webgl2';
    private query: DescriptorTexture | null = null;
    private train: DescriptorTexture | null = null;
    private output: GlTarget | null = null;

    private constructor(
        private readonly context: GlContext,
        private readonly program: GlProgram,
    ) {}

    static create(context: GlContext): GpuMatchBackend | null {
        const program = context.program(NEAREST, ['uQuery', 'uTrain', 'uTrainCount']);
        return program ? new GpuMatchBackend(context, program) : null;
    }

    nearest(
        query: Uint32Array,
        queryCount: number,
        train: Uint32Array,
        trainCount: number,
    ): NearestNeighbours | null {
        if (queryCount === 0 || trainCount === 0) return null;
        this.query = this.upload(this.query, query, queryCount);
        this.train = this.upload(this.train, train, trainCount);
        this.output = this.ensureOutput(queryCount);
        if (!this.query || !this.train || !this.output) return null;
        const gl = this.context.gl;
        const uniforms = this.program.uniforms;
        const queryTexture = this.query.texture;
        const trainTexture = this.train.texture;
        this.context.draw(this.program, this.output, queryCount, 1, () => {
            this.context.bindInput(0, queryTexture, uniforms['uQuery']);
            this.context.bindInput(1, trainTexture, uniforms['uTrain']);
            gl.uniform1i(uniforms['uTrainCount'], trainCount);
        });
        const raw = new Uint32Array(queryCount * 4);
        gl.readPixels(0, 0, queryCount, 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, raw);
        if (!this.context.finish()) return null;
        const index = new Int32Array(queryCount);
        const best = new Uint32Array(queryCount);
        const second = new Uint32Array(queryCount);
        for (let q = 0; q < queryCount; q++) {
            index[q] = raw[q * 4];
            best[q] = raw[q * 4 + 1];
            second[q] = raw[q * 4 + 2];
        }
        return { index, best, second };
    }

    private upload(
        existing: DescriptorTexture | null,
        data: Uint32Array,
        count: number,
    ): DescriptorTexture | null {
        const gl = this.context.gl;
        let slot = existing;
        if (!slot || slot.rows < count) {
            if (slot) gl.deleteTexture(slot.texture);
            const rows = Math.max(count, 64);
            const texture = this.context.uintTexture(2, rows);
            if (!texture) return null;
            slot = { texture, rows };
        }
        gl.bindTexture(gl.TEXTURE_2D, slot.texture);
        gl.texSubImage2D(
            gl.TEXTURE_2D,
            0,
            0,
            0,
            2,
            count,
            gl.RGBA_INTEGER,
            gl.UNSIGNED_INT,
            data.subarray(0, count * DESCRIPTOR_WORDS),
        );
        return slot;
    }

    private ensureOutput(width: number): GlTarget | null {
        if (this.output && this.output.width >= width) return this.output;
        this.context.release(this.output);
        const capacity = Math.max(width, 128);
        return this.context.target(this.context.uintTexture(capacity, 1), capacity, 1);
    }
}

class RoutedMatchBackend extends RoutedBackend<MatchBackend> implements MatchBackend {
    nearest(
        query: Uint32Array,
        queryCount: number,
        train: Uint32Array,
        trainCount: number,
    ): NearestNeighbours | null {
        return this.route(queryCount * trainCount, (backend) =>
            backend.nearest(query, queryCount, train, trainCount),
        );
    }
}

function randomDescriptors(count: number, seed: number): Uint32Array {
    const words = new Uint32Array(count * DESCRIPTOR_WORDS);
    let state = seed;
    for (let i = 0; i < words.length; i++) {
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        words[i] = state;
    }
    return words;
}

const matchCalibration: Calibration<MatchBackend> = {
    cpu: cpuMatchBackend,
    workloads: CALIBRATION_COUNTS.map((count) => count * count),
    createGpu: (context) => GpuMatchBackend.create(context),
    agrees(gpu, cpu, workload) {
        const count = Math.sqrt(workload);
        const query = randomDescriptors(count, 12345);
        const train = randomDescriptors(count, 54321);
        const expected = cpu.nearest(query, count, train, count);
        const actual = gpu.nearest(query, count, train, count);
        if (!expected || !actual) return false;
        for (let i = 0; i < count; i++) {
            if (
                expected.index[i] !== actual.index[i] ||
                expected.best[i] !== actual.best[i] ||
                expected.second[i] !== actual.second[i]
            ) {
                return false;
            }
        }
        return true;
    },
    run(backend, workload) {
        const count = Math.sqrt(workload);
        const query = randomDescriptors(count, 777);
        const train = randomDescriptors(count, 999);
        return backend.nearest(query, count, train, count) !== null;
    },
    route: (gpu, cpu, threshold) => new RoutedMatchBackend(gpu, cpu, threshold),
    describeWorkload: (workload) => `${Math.sqrt(workload)} descritores`,
};

export function createMatchSelector(): BackendSelector<MatchBackend> {
    return new BackendSelector(matchCalibration);
}
