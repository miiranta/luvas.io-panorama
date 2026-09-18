import { CanvasBox } from '../warping/canvas-box';
import { MosaicGrid } from './mosaic-grid';
import {
    MosaicSurface,
    MosaicView,
    TileSnapshot,
    cellSource,
    snapshotGrid,
} from './mosaic-surface';
import { WarpTile } from '../warping/warp-tile';
import { REDUCE_SHADER } from './blur-backend';
import { GlContext, GlProgram, GlTarget, growTarget } from '../../foundation/gpu/gl-context';

const ACCUMULATE = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uCurrent;
uniform sampler2D uCoarse;
uniform int uHasCoarse;
uniform ivec2 uOffset;
uniform ivec2 uCoarseSize;
uniform float uMinWeight;
out vec4 fragColor;

vec4 coarseAt(ivec2 p) {
    return texelFetch(uCoarse, clamp(p, ivec2(0), uCoarseSize - 1), 0);
}

void main() {
    ivec2 t = ivec2(gl_FragCoord.xy) + uOffset;
    vec4 g = texelFetch(uCurrent, t, 0);
    if (g.a <= uMinWeight) {
        fragColor = vec4(0.0);
        return;
    }
    vec3 value = g.rgb / g.a;
    if (uHasCoarse == 1) {
        vec2 p = vec2(t) * 0.5;
        ivec2 p0 = ivec2(floor(p));
        vec2 f = p - vec2(p0);
        vec4 c = mix(
            mix(coarseAt(p0), coarseAt(p0 + ivec2(1, 0)), f.x),
            mix(coarseAt(p0 + ivec2(0, 1)), coarseAt(p0 + ivec2(1, 1)), f.x),
            f.y
        );
        if (c.a > 1e-6) value -= c.rgb / c.a;
    }
    fragColor = vec4(value * g.a, g.a);
}`;

const COLLAPSE = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uBand;
uniform sampler2D uOverlay;
uniform sampler2D uPrevious;
uniform int uHasOverlay;
uniform int uHasPrevious;
uniform ivec2 uOrigin;
uniform ivec2 uPrevOrigin;
uniform ivec2 uPrevSize;
uniform float uScale;
uniform float uMinWeight;
out vec4 fragColor;

vec4 previousAt(ivec2 p) {
    return texelFetch(uPrevious, clamp(p, ivec2(0), uPrevSize - 1), 0);
}

void main() {
    ivec2 pos = ivec2(gl_FragCoord.xy) + uOrigin;
    vec4 b = texelFetch(uBand, pos, 0);
    if (uHasOverlay == 1) b += texelFetch(uOverlay, pos, 0);
    vec3 value = vec3(0.0);
    if (uHasPrevious == 1) {
        vec2 p = clamp(vec2(pos) * 0.5 - vec2(uPrevOrigin), vec2(0.0), vec2(uPrevSize - 1));
        ivec2 p0 = ivec2(floor(p));
        vec2 f = p - vec2(p0);
        value = mix(
            mix(previousAt(p0), previousAt(p0 + ivec2(1, 0)), f.x),
            mix(previousAt(p0 + ivec2(0, 1)), previousAt(p0 + ivec2(1, 1)), f.x),
            f.y
        ).rgb;
    }
    if (b.a > uMinWeight) value += b.rgb / b.a;
    fragColor = vec4(value * uScale, 1.0);
}`;

const SNAPSHOT = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uFlat;
uniform ivec2 uTileOrigin;
uniform ivec2 uTileSize;
uniform int uStep;
uniform ivec2 uMosaicSize;
uniform ivec2 uMosaicOrigin;
uniform float uCanvasWidth;
out vec4 fragColor;

void main() {
    ivec2 cell = ivec2(gl_FragCoord.xy);
    int sx = min(uTileSize.x - 1, cell.x * uStep + uStep / 2);
    int sy = min(uTileSize.y - 1, cell.y * uStep + uStep / 2);
    float raw = float(uTileOrigin.x + sx);
    float absolute = raw - uCanvasWidth * floor(raw / uCanvasWidth);
    float local = absolute - float(uMosaicOrigin.x);
    if (local < 0.0) local += uCanvasWidth;
    int row = uTileOrigin.y + sy - uMosaicOrigin.y;
    if (local >= float(uMosaicSize.x) || row < 0 || row >= uMosaicSize.y) {
        fragColor = vec4(0.0);
        return;
    }
    fragColor = texelFetch(uFlat, ivec2(int(local), row), 0);
}`;

interface GpuPrograms {
    accumulate: GlProgram;
    collapse: GlProgram;
    snapshot: GlProgram;
    reduce: GlProgram;
}

const programCache = new WeakMap<GlContext, GpuPrograms | null>();

interface SharedPools {
    scratch: GlTarget[];
    regions: GlTarget[];
    final: GlTarget[];
}

const poolCache = new WeakMap<GlContext, SharedPools>();

function poolsFor(context: GlContext): SharedPools {
    let pools = poolCache.get(context);
    if (!pools) {
        pools = { scratch: [], regions: [], final: [] };
        poolCache.set(context, pools);
    }
    return pools;
}

function programsFor(context: GlContext): GpuPrograms | null {
    if (programCache.has(context)) return programCache.get(context) ?? null;
    const accumulate = context.program(ACCUMULATE, [
        'uCurrent',
        'uCoarse',
        'uHasCoarse',
        'uOffset',
        'uCoarseSize',
        'uMinWeight',
    ]);
    const collapse = context.program(COLLAPSE, [
        'uBand',
        'uOverlay',
        'uPrevious',
        'uHasOverlay',
        'uHasPrevious',
        'uOrigin',
        'uPrevOrigin',
        'uPrevSize',
        'uScale',
        'uMinWeight',
    ]);
    const snapshot = context.program(SNAPSHOT, [
        'uFlat',
        'uTileOrigin',
        'uTileSize',
        'uStep',
        'uMosaicSize',
        'uMosaicOrigin',
        'uCanvasWidth',
    ]);
    const reduce = context.program(REDUCE_SHADER, ['uSource', 'uSourceSize']);
    const programs =
        accumulate && collapse && snapshot && reduce
            ? { accumulate, collapse, snapshot, reduce }
            : null;
    programCache.set(context, programs);
    return programs;
}

export class GpuMosaic extends MosaicGrid implements MosaicSurface {
    readonly kind = 'webgl2';
    private readonly flat: GlTarget;
    private readonly bandTargets: GlTarget[] = [];
    private readonly scratch: GlTarget[];
    private readonly regions: GlTarget[];
    private readonly finals: GlTarget[];
    private readonly empty: WebGLTexture;
    private tile: WebGLTexture | null = null;
    private tileWidth = 0;
    private tileHeight = 0;
    private disposed = false;

    private constructor(
        private readonly context: GlContext,
        private readonly programs: GpuPrograms,
        width: number,
        height: number,
        bands: number,
        view: MosaicView | undefined,
        flat: GlTarget,
        bandTargets: GlTarget[],
        empty: WebGLTexture,
    ) {
        super(width, height, bands, view);
        const pools = poolsFor(context);
        this.scratch = pools.scratch;
        this.regions = pools.regions;
        this.finals = pools.final;
        this.flat = flat;
        this.bandTargets = bandTargets;
        this.empty = empty;
    }

    static create(
        context: GlContext,
        width: number,
        height: number,
        bands: number,
        view?: MosaicView,
    ): GpuMosaic | null {
        const programs = programsFor(context);
        if (!programs || !context.blendsFloat) return null;
        const limit = context.maxTextureSize;
        if (width > limit || height > limit) return null;
        const flat = context.target(context.floatTexture(width, height), width, height);
        if (!flat) return null;
        const targets: GlTarget[] = [];
        for (let level = 0; level < Math.max(1, bands); level++) {
            const levelWidth = Math.max(1, Math.ceil(width / (1 << level)));
            const levelHeight = Math.max(1, Math.ceil(height / (1 << level)));
            const target = context.target(
                context.floatTexture(levelWidth, levelHeight),
                levelWidth,
                levelHeight,
            );
            if (!target) {
                context.release(flat);
                for (const created of targets) context.release(created);
                return null;
            }
            targets.push(target);
        }
        const empty = context.floatTexture(1, 1);
        if (!empty) return null;
        const mosaic = new GpuMosaic(
            context,
            programs,
            width,
            height,
            bands,
            view,
            flat,
            targets,
            empty,
        );
        mosaic.clearTarget(flat, { u0: 0, v0: 0, u1: width - 1, v1: height - 1 });
        for (const target of targets) {
            mosaic.clearTarget(target, {
                u0: 0,
                v0: 0,
                u1: target.width - 1,
                v1: target.height - 1,
            });
        }
        return context.finish() ? mosaic : null;
    }

    snapshot(tile: WarpTile, step: number): TileSnapshot {
        const { width, height } = snapshotGrid(tile, step);
        const cells = width * height;
        const mean = new Float32Array(cells * 3);
        const filled = new Uint8Array(cells);
        const covered = new Uint8Array(cells);
        const gl = this.context.gl;
        const target = this.sized(this.scratch, 0, width, height);
        if (!target) return { width, height, step, mean, filled, covered };
        const program = this.programs.snapshot;
        this.run(program, target, 0, 0, width, height, () => {
            this.context.bindInput(0, this.flat.texture, program.uniforms['uFlat']);
            gl.uniform2i(program.uniforms['uTileOrigin'], tile.u0, tile.v0);
            gl.uniform2i(program.uniforms['uTileSize'], tile.width, tile.height);
            gl.uniform1i(program.uniforms['uStep'], step);
            gl.uniform2i(program.uniforms['uMosaicSize'], this.width, this.height);
            gl.uniform2i(program.uniforms['uMosaicOrigin'], this.originU, this.originV);
            gl.uniform1f(program.uniforms['uCanvasWidth'], this.canvasWidth);
        });
        const data = new Float32Array(cells * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, data);
        this.context.finish();
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const cell = y * width + x;
                const [sx, sy] = cellSource(tile, step, x, y);
                const index = this.indexAt(tile.u0 + sx, tile.v0 + sy);
                if (index >= 0) covered[cell] = this.coverage[index];
                const weight = data[cell * 4 + 3];
                if (weight <= 1e-6) continue;
                filled[cell] = 1;
                mean[cell * 3] = data[cell * 4] / weight;
                mean[cell * 3 + 1] = data[cell * 4 + 1] / weight;
                mean[cell * 3 + 2] = data[cell * 4 + 2] / weight;
            }
        }
        return { width, height, step, mean, filled, covered };
    }

    addFlat(tile: WarpTile): void {
        this.uploadTile(tile);
        this.accumulate(
            0,
            this.flat,
            tile,
            this.tile as WebGLTexture,
            null,
            tile.width,
            tile.height,
            0,
        );
        this.markCoverage(tile);
    }

    addPyramidBands(tile: WarpTile): void {
        this.uploadTile(tile);
        const levels: { texture: WebGLTexture; width: number; height: number }[] = [
            { texture: this.tile as WebGLTexture, width: tile.width, height: tile.height },
        ];
        for (let level = 1; level < this.bands; level++) {
            const previous = levels[level - 1];
            if (previous.width <= 2 || previous.height <= 2) {
                levels.push(previous);
                continue;
            }
            const width = Math.max(1, previous.width >> 1);
            const height = Math.max(1, previous.height >> 1);
            const target = this.sized(this.scratch, level, width, height);
            if (!target) return;
            const program = this.programs.reduce;
            this.run(program, target, 0, 0, width, height, () => {
                this.context.bindInput(0, previous.texture, program.uniforms['uSource']);
                this.context.gl.uniform2i(
                    program.uniforms['uSourceSize'],
                    previous.width,
                    previous.height,
                );
            });
            levels.push({ texture: target.texture, width, height });
        }
        for (let level = 0; level < this.bands; level++) {
            const current = levels[level];
            const coarse = level + 1 < levels.length ? levels[level + 1] : null;
            const coarser = coarse && coarse.texture !== current.texture ? coarse : null;
            this.accumulate(
                level,
                this.bandTargets[level],
                tile,
                current.texture,
                coarser,
                current.width,
                current.height,
                1e-5,
            );
        }
        this.accumulate(
            0,
            this.flat,
            tile,
            this.tile as WebGLTexture,
            null,
            tile.width,
            tile.height,
            0,
        );
        this.markCoverage(tile);
    }

    render(
        useBands: boolean,
        overlay?: MosaicSurface | null,
        region?: CanvasBox | null,
    ): ImageData {
        const box: CanvasBox = region ?? { u0: 0, v0: 0, u1: this.width - 1, v1: this.height - 1 };
        const width = box.u1 - box.u0 + 1;
        const height = box.v1 - box.v0 + 1;
        const extra =
            overlay instanceof GpuMosaic &&
            overlay.width === this.width &&
            overlay.height === this.height &&
            overlay.bands === this.bands
                ? overlay
                : null;
        const gl = this.context.gl;
        const final = this.byteTarget(width, height);
        const out = new Uint8ClampedArray(width * height * 4);
        if (!final) return new ImageData(out, width, height);
        if (useBands) {
            let previous: {
                texture: WebGLTexture;
                u0: number;
                v0: number;
                width: number;
                height: number;
            } | null = null;
            for (let level = this.bands - 1; level >= 0; level--) {
                const isFinal = level === 0;
                const stride = this.bandWidth[level];
                const u0 = isFinal ? box.u0 : Math.max(0, (box.u0 >> level) - 1);
                const v0 = isFinal ? box.v0 : Math.max(0, (box.v0 >> level) - 1);
                const u1 = isFinal ? box.u1 : Math.min(stride - 1, (box.u1 >> level) + 1);
                const v1 = isFinal
                    ? box.v1
                    : Math.min(this.bandHeight[level] - 1, (box.v1 >> level) + 1);
                const regionWidth = u1 - u0 + 1;
                const regionHeight = v1 - v0 + 1;
                const target = isFinal
                    ? final
                    : this.sized(this.regions, level, regionWidth, regionHeight);
                if (!target) return new ImageData(out, width, height);
                const program = this.programs.collapse;
                const prior = previous;
                this.run(program, target, 0, 0, regionWidth, regionHeight, () => {
                    this.context.bindInput(
                        0,
                        this.bandTargets[level].texture,
                        program.uniforms['uBand'],
                    );
                    this.context.bindInput(
                        1,
                        extra ? extra.bandTargets[level].texture : this.empty,
                        program.uniforms['uOverlay'],
                    );
                    this.context.bindInput(
                        2,
                        prior ? prior.texture : this.empty,
                        program.uniforms['uPrevious'],
                    );
                    gl.uniform1i(program.uniforms['uHasOverlay'], extra ? 1 : 0);
                    gl.uniform1i(program.uniforms['uHasPrevious'], prior ? 1 : 0);
                    gl.uniform2i(program.uniforms['uOrigin'], u0, v0);
                    gl.uniform2i(program.uniforms['uPrevOrigin'], prior?.u0 ?? 0, prior?.v0 ?? 0);
                    gl.uniform2i(
                        program.uniforms['uPrevSize'],
                        prior?.width ?? 1,
                        prior?.height ?? 1,
                    );
                    gl.uniform1f(program.uniforms['uScale'], isFinal ? 1 / 255 : 1);
                    gl.uniform1f(program.uniforms['uMinWeight'], 1e-5);
                });
                previous = {
                    texture: target.texture,
                    u0,
                    v0,
                    width: regionWidth,
                    height: regionHeight,
                };
            }
        } else {
            const program = this.programs.collapse;
            this.run(program, final, 0, 0, width, height, () => {
                this.context.bindInput(0, this.flat.texture, program.uniforms['uBand']);
                this.context.bindInput(
                    1,
                    extra ? extra.flat.texture : this.empty,
                    program.uniforms['uOverlay'],
                );
                this.context.bindInput(2, this.empty, program.uniforms['uPrevious']);
                gl.uniform1i(program.uniforms['uHasOverlay'], extra ? 1 : 0);
                gl.uniform1i(program.uniforms['uHasPrevious'], 0);
                gl.uniform2i(program.uniforms['uOrigin'], box.u0, box.v0);
                gl.uniform2i(program.uniforms['uPrevOrigin'], 0, 0);
                gl.uniform2i(program.uniforms['uPrevSize'], 1, 1);
                gl.uniform1f(program.uniforms['uScale'], 1 / 255);
                gl.uniform1f(program.uniforms['uMinWeight'], 1e-6);
            });
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, final.framebuffer);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, out);
        this.context.finish();
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const index = (box.v0 + y) * this.width + box.u0 + x;
                const o = (y * width + x) * 4;
                if (this.coverage[index] || extra?.coverage[index]) {
                    out[o + 3] = 255;
                } else {
                    out[o] = 0;
                    out[o + 1] = 0;
                    out[o + 2] = 0;
                    out[o + 3] = 0;
                }
            }
        }
        return new ImageData(out, width, height);
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        const gl = this.context.gl;
        this.context.release(this.flat);
        for (const target of this.bandTargets) this.context.release(target);
        if (this.tile) gl.deleteTexture(this.tile);
        gl.deleteTexture(this.empty);
    }

    protected clearAccumulators(box: CanvasBox): void {
        this.clearTarget(this.flat, box);
        for (let level = 0; level < this.bands; level++) {
            const target = this.bandTargets[level];
            this.clearTarget(target, {
                u0: box.u0 >> level,
                v0: box.v0 >> level,
                u1: Math.min(target.width - 1, box.u1 >> level),
                v1: Math.min(target.height - 1, box.v1 >> level),
            });
        }
    }

    private accumulate(
        level: number,
        target: GlTarget,
        tile: WarpTile,
        current: WebGLTexture,
        coarse: { texture: WebGLTexture; width: number; height: number } | null,
        width: number,
        height: number,
        minWeight: number,
    ): void {
        const gl = this.context.gl;
        const baseV = tile.v0 >> level;
        let firstRow = -1;
        let firstY = 0;
        let rows = 0;
        for (let y = 0; y < height; y++) {
            const row = this.levelRow(level, baseV + y);
            if (row < 0) continue;
            if (firstRow < 0) {
                firstRow = row;
                firstY = y;
            }
            rows++;
        }
        if (rows === 0) return;
        const program = this.programs.accumulate;
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.ONE, gl.ONE);
        for (const run of this.columnRuns(level, tile.u0 >> level, width)) {
            this.run(program, target, run.localStart, firstRow, run.length, rows, () => {
                this.context.bindInput(0, current, program.uniforms['uCurrent']);
                this.context.bindInput(
                    1,
                    coarse ? coarse.texture : this.empty,
                    program.uniforms['uCoarse'],
                );
                gl.uniform1i(program.uniforms['uHasCoarse'], coarse ? 1 : 0);
                gl.uniform2i(
                    program.uniforms['uOffset'],
                    run.tileStart - run.localStart,
                    firstY - firstRow,
                );
                gl.uniform2i(
                    program.uniforms['uCoarseSize'],
                    coarse?.width ?? 1,
                    coarse?.height ?? 1,
                );
                gl.uniform1f(program.uniforms['uMinWeight'], minWeight);
            });
        }
        gl.disable(gl.BLEND);
    }

    private run(
        program: GlProgram,
        target: GlTarget,
        x: number,
        y: number,
        width: number,
        height: number,
        bind: () => void,
    ): void {
        const gl = this.context.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
        gl.viewport(x, y, width, height);
        gl.useProgram(program.program);
        gl.bindVertexArray(program.vao);
        bind();
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindVertexArray(null);
    }

    private clearTarget(target: GlTarget, box: CanvasBox): void {
        if (box.u1 < box.u0 || box.v1 < box.v0) return;
        const gl = this.context.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(box.u0, box.v0, box.u1 - box.u0 + 1, box.v1 - box.v0 + 1);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.disable(gl.SCISSOR_TEST);
    }

    private uploadTile(tile: WarpTile): void {
        const gl = this.context.gl;
        const n = tile.width * tile.height;
        const data = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) {
            const mask = tile.mask[i];
            data[i * 4] = tile.color[i * 3] * mask;
            data[i * 4 + 1] = tile.color[i * 3 + 1] * mask;
            data[i * 4 + 2] = tile.color[i * 3 + 2] * mask;
            data[i * 4 + 3] = mask;
        }
        if (!this.tile || this.tileWidth < tile.width || this.tileHeight < tile.height) {
            if (this.tile) gl.deleteTexture(this.tile);
            this.tileWidth = Math.max(this.tileWidth, tile.width);
            this.tileHeight = Math.max(this.tileHeight, tile.height);
            this.tile = this.context.floatTexture(this.tileWidth, this.tileHeight);
        }
        gl.bindTexture(gl.TEXTURE_2D, this.tile);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, tile.width, tile.height, gl.RGBA, gl.FLOAT, data);
    }

    private sized(pool: GlTarget[], slot: number, width: number, height: number): GlTarget | null {
        const target = growTarget(this.context, pool[slot] ?? null, width, height, 'float');
        if (target) pool[slot] = target;
        return target;
    }

    private byteTarget(width: number, height: number): GlTarget | null {
        const target = growTarget(this.context, this.finals[0] ?? null, width, height, 'byte');
        if (target) this.finals[0] = target;
        return target;
    }
}
