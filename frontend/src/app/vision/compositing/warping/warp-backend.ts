import { CanvasGeometry } from './canvas-geometry';
import { distortFactor } from '../../registration/alignment/lens-distortion';
import { vignetteAt } from '../photometric/vignetting';
import { ColorImage, Rgb, UNIT_RGB, imageCenter } from '../../foundation/imaging/image';
import { mipPyramidFor, sampleMipmapped } from './mip-pyramid';
import { Mat3, mat3Identity, mat3Multiply } from '../../foundation/math/matrix3';
import {
    Backend,
    BackendSelector,
    Calibration,
    RoutedBackend,
} from '../../foundation/gpu/backend-selector';
import { GlContext, GlProgram, GlTarget, growTarget } from '../../foundation/gpu/gl-context';

const CALIBRATION_SIDES = [128, 256, 512];
const AGREEMENT_TOLERANCE = 1.5;
const SURFACE_CODE: Record<string, number> = { planar: 0, cylindrical: 1, spherical: 2 };

export interface WarpRequest {
    geometry: CanvasGeometry;
    rotation: Mat3;
    source: ColorImage;
    focal: number;
    distortion: number;
    vignetting: number;
    gain: Rgb;
    feather: number;
    u0: number;
    v0: number;
    width: number;
    height: number;
}

export interface WarpResult {
    color: Float32Array;
    mask: Float32Array;
    pixels: number;
}

export interface WarpBackend extends Backend {
    warp(request: WarpRequest): WarpResult | null;
}

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D uSource;
uniform mat3 uOrientation;
uniform mat3 uRotation;
uniform vec2 uCanvasSize;
uniform vec2 uTileOrigin;
uniform vec2 uSourceSize;
uniform float uPlanarScale;
uniform float uCylinderHalf;
uniform float uFocal;
uniform float uDistortion;
uniform float uVignetting;
uniform vec3 uGain;
uniform float uFeather;
uniform int uSurface;
uniform int uWraps;
out vec4 fragColor;

vec3 surfaceRay(float u, float v) {
    if (uSurface == 2) {
        float theta = (u / uCanvasSize.x) * 6.283185307179586 - 3.141592653589793;
        float phi = (v / uCanvasSize.y) * 3.141592653589793 - 1.5707963267948966;
        float cosPhi = cos(phi);
        return vec3(cosPhi * sin(theta), sin(phi), cosPhi * cos(theta));
    }
    if (uSurface == 1) {
        float theta = (u / uCanvasSize.x) * 6.283185307179586 - 3.141592653589793;
        float h = (v / uCanvasSize.y - 0.5) * 2.0 * uCylinderHalf;
        return vec3(sin(theta), h, cos(theta));
    }
    return vec3(
        (u - uCanvasSize.x * 0.5) / uPlanarScale,
        (v - uCanvasSize.y * 0.5) / uPlanarScale,
        1.0
    );
}

vec4 keysWeights(float t) {
    float t2 = t * t;
    float t3 = t2 * t;
    return vec4(
        -0.5 * t3 + t2 - 0.5 * t,
        1.5 * t3 - 2.5 * t2 + 1.0,
        -1.5 * t3 + 2.0 * t2 + 0.5 * t,
        0.5 * t3 - 0.5 * t2
    );
}

vec3 sampleBicubic(vec2 p) {
    ivec2 last = ivec2(uSourceSize) - 1;
    vec2 origin = floor(p);
    vec4 weightsX = keysWeights(p.x - origin.x);
    vec4 weightsY = keysWeights(p.y - origin.y);
    ivec2 base = ivec2(origin) - 1;
    vec3 sum = vec3(0.0);
    for (int j = 0; j < 4; j++) {
        vec3 line = vec3(0.0);
        for (int i = 0; i < 4; i++) {
            ivec2 texel = clamp(base + ivec2(i, j), ivec2(0), last);
            line += texelFetch(uSource, texel, 0).rgb * weightsX[i];
        }
        sum += line * weightsY[j];
    }
    return sum;
}

vec3 sampleMipmapped(vec2 p, float lod) {
    vec2 uv = (p + 0.5) / uSourceSize;
    if (lod >= 1.0) return textureLod(uSource, uv, lod).rgb;
    return mix(sampleBicubic(p), textureLod(uSource, uv, 1.0).rgb, lod);
}

void main() {
    fragColor = vec4(0.0);
    float raw = uTileOrigin.x + gl_FragCoord.x - 0.5;
    float cu = mod(mod(raw, uCanvasSize.x) + uCanvasSize.x, uCanvasSize.x) + 0.5;
    float cv = uTileOrigin.y + gl_FragCoord.y;
    vec3 cam = uRotation * (uOrientation * surfaceRay(cu, cv));
    vec2 normalized = cam.xy / max(cam.z, 1e-6);
    float lens = 1.0 + uDistortion * dot(normalized, normalized);
    vec2 center = (uSourceSize - 1.0) * 0.5;
    vec2 p = uFocal * normalized * lens + center;
    float spread = max(length(dFdx(p)), length(dFdy(p)));
    if (uWraps == 0 && (raw < 0.0 || raw >= uCanvasSize.x)) return;
    if (cam.z <= 1e-6) return;
    if (any(lessThan(p, vec2(0.0))) || any(greaterThan(p, uSourceSize - 1.0))) return;
    vec3 color = sampleMipmapped(p, log2(max(spread, 1.0)));
    float edge = min(min(p.x, uSourceSize.x - 1.0 - p.x), min(p.y, uSourceSize.y - 1.0 - p.y));
    vec2 offset = (p - center) / uFocal;
    float falloff = max(0.05, 1.0 + uVignetting * dot(offset, offset));
    fragColor = vec4(clamp(color * uGain / falloff, 0.0, 1.0), min(1.0, (edge + 0.5) / uFeather));
}`;

export const cpuWarpBackend: WarpBackend = {
    kind: 'cpu',
    warp(request: WarpRequest): WarpResult {
        const { geometry, rotation, source, focal, distortion, vignetting, gain, feather } =
            request;
        const { u0, v0, width, height } = request;
        const wraps = geometry.surface !== 'planar';
        const canvasWidth = geometry.width;
        const canvasHeight = geometry.height;
        const m = mat3Multiply(rotation, geometry.orientation);
        const columnA = new Float64Array(width);
        const columnB = new Float64Array(width);
        const inside = new Uint8Array(width);
        for (let x = 0; x < width; x++) {
            const raw = u0 + x;
            if (!wraps && (raw < 0 || raw >= canvasWidth)) continue;
            inside[x] = 1;
            const cu = (((raw % canvasWidth) + canvasWidth) % canvasWidth) + 0.5;
            if (geometry.surface === 'planar') {
                columnA[x] = (cu - canvasWidth / 2) / geometry.planarScale;
                columnB[x] = 1;
            } else {
                const theta = (cu / canvasWidth) * Math.PI * 2 - Math.PI;
                columnA[x] = Math.sin(theta);
                columnB[x] = Math.cos(theta);
            }
        }
        const projected = new Float32Array(width * height * 2);
        const cx = imageCenter(source.width);
        const cy = imageCenter(source.height);
        let pixels = 0;
        for (let y = 0; y < height; y++) {
            const cv = v0 + y + 0.5;
            let rowA = 0;
            let rowB = 1;
            if (geometry.surface === 'spherical') {
                const phi = (cv / canvasHeight) * Math.PI - Math.PI / 2;
                rowA = Math.sin(phi);
                rowB = Math.cos(phi);
            } else if (geometry.surface === 'cylindrical') {
                rowA = (cv / canvasHeight - 0.5) * 2 * geometry.cylinderHalfHeight;
            } else {
                rowA = (cv - canvasHeight / 2) / geometry.planarScale;
            }
            const base = y * width * 2;
            for (let x = 0; x < width; x++) {
                const t = base + x * 2;
                projected[t] = Number.NaN;
                if (!inside[x]) continue;
                const dx = columnA[x] * rowB;
                const dy = rowA;
                const dz = columnB[x] * rowB;
                const camZ = m[6] * dx + m[7] * dy + m[8] * dz;
                if (camZ <= 1e-6) continue;
                const nx = (m[0] * dx + m[1] * dy + m[2] * dz) / camZ;
                const ny = (m[3] * dx + m[4] * dy + m[5] * dz) / camZ;
                const lens = distortFactor(nx, ny, distortion);
                const px = focal * nx * lens + cx;
                const py = focal * ny * lens + cy;
                if (px < 0 || py < 0 || px > source.width - 1 || py > source.height - 1) continue;
                projected[t] = px;
                projected[t + 1] = py;
                pixels++;
            }
        }
        const color = new Float32Array(width * height * 3);
        const mask = new Float32Array(width * height);
        if (pixels === 0) return { color, mask, pixels };
        const levels = mipPyramidFor(source);
        const sample = new Float32Array(3);
        const scratch = new Float32Array(3);
        const edgeX = source.width - 1;
        const edgeY = source.height - 1;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const index = y * width + x;
                const px = projected[index * 2];
                if (Number.isNaN(px)) continue;
                const py = projected[index * 2 + 1];
                sampleMipmapped(
                    levels,
                    px,
                    py,
                    levelOfDetail(projected, width, height, x, y, px, py),
                    sample,
                    scratch,
                );
                const ox = (px - cx) / focal;
                const oy = (py - cy) / focal;
                const falloff = vignetteAt(ox * ox + oy * oy, vignetting);
                for (let c = 0; c < 3; c++) {
                    color[index * 3 + c] = clampByte((sample[c] * gain[c]) / falloff);
                }
                const edge = Math.min(Math.min(px, edgeX - px), Math.min(py, edgeY - py));
                mask[index] = Math.min(1, (edge + 0.5) / feather);
            }
        }
        return { color, mask, pixels };
    },
};

function clampByte(value: number): number {
    return Math.min(255, Math.max(0, value));
}

function span(
    projected: Float32Array,
    width: number,
    height: number,
    nx: number,
    ny: number,
    px: number,
    py: number,
): number {
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) return 0;
    const t = (ny * width + nx) * 2;
    const qx = projected[t];
    if (Number.isNaN(qx)) return 0;
    return Math.hypot(px - qx, py - projected[t + 1]);
}

function levelOfDetail(
    projected: Float32Array,
    width: number,
    height: number,
    x: number,
    y: number,
    px: number,
    py: number,
): number {
    const nx = x > 0 ? x - 1 : Math.min(width - 1, x + 1);
    const ny = y > 0 ? y - 1 : Math.min(height - 1, y + 1);
    const distance = Math.max(
        span(projected, width, height, nx, y, px, py),
        span(projected, width, height, x, ny, px, py),
    );
    return distance > 1 ? Math.log2(distance) : 0;
}

class GpuWarpBackend implements WarpBackend {
    readonly kind = 'webgl2';
    private target: GlTarget | null = null;
    private texture: WebGLTexture | null = null;
    private textureWidth = 0;
    private textureHeight = 0;
    private uploaded: ColorImage | null = null;
    private readback = new Uint8Array(0);

    private constructor(
        private readonly context: GlContext,
        private readonly program: GlProgram,
    ) {}

    static create(context: GlContext): GpuWarpBackend | null {
        const program = context.program(FRAGMENT, [
            'uSource',
            'uOrientation',
            'uRotation',
            'uCanvasSize',
            'uTileOrigin',
            'uSourceSize',
            'uPlanarScale',
            'uCylinderHalf',
            'uFocal',
            'uDistortion',
            'uVignetting',
            'uGain',
            'uFeather',
            'uSurface',
            'uWraps',
        ]);
        return program ? new GpuWarpBackend(context, program) : null;
    }

    warp(request: WarpRequest): WarpResult | null {
        const { geometry, source, width, height } = request;
        if (width < 1 || height < 1) return null;
        if (!this.allocate(width, height) || !this.uploadSource(source)) return null;
        const gl = this.context.gl;
        const target = this.target as GlTarget;
        const uniforms = this.program.uniforms;
        this.context.draw(this.program, target, width, height, () => {
            this.context.bindInput(0, this.texture as WebGLTexture, uniforms['uSource']);
            gl.uniformMatrix3fv(uniforms['uOrientation'], false, columnMajor(geometry.orientation));
            gl.uniformMatrix3fv(uniforms['uRotation'], false, columnMajor(request.rotation));
            gl.uniform2f(uniforms['uCanvasSize'], geometry.width, geometry.height);
            gl.uniform2f(uniforms['uTileOrigin'], request.u0, request.v0);
            gl.uniform2f(uniforms['uSourceSize'], source.width, source.height);
            gl.uniform1f(uniforms['uPlanarScale'], geometry.planarScale);
            gl.uniform1f(uniforms['uCylinderHalf'], geometry.cylinderHalfHeight);
            gl.uniform1f(uniforms['uFocal'], request.focal);
            gl.uniform1f(uniforms['uDistortion'], request.distortion);
            gl.uniform1f(uniforms['uVignetting'], request.vignetting);
            gl.uniform3f(uniforms['uGain'], ...request.gain);
            gl.uniform1f(uniforms['uFeather'], Math.max(1, request.feather));
            gl.uniform1i(uniforms['uSurface'], SURFACE_CODE[geometry.surface] ?? 0);
            gl.uniform1i(uniforms['uWraps'], geometry.surface === 'planar' ? 0 : 1);
        });
        const count = width * height;
        if (this.readback.length !== count * 4) this.readback = new Uint8Array(count * 4);
        const packed = this.readback;
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, packed);
        if (!this.context.finish()) return null;
        const color = new Float32Array(count * 3);
        const mask = new Float32Array(count);
        let pixels = 0;
        for (let i = 0; i < count; i++) {
            const alpha = packed[i * 4 + 3];
            if (alpha === 0) continue;
            color[i * 3] = packed[i * 4];
            color[i * 3 + 1] = packed[i * 4 + 1];
            color[i * 3 + 2] = packed[i * 4 + 2];
            mask[i] = alpha / 255;
            pixels++;
        }
        return { color, mask, pixels };
    }

    private allocate(width: number, height: number): boolean {
        this.target = growTarget(this.context, this.target, width, height, 'byte');
        return this.target !== null;
    }

    private uploadSource(source: ColorImage): boolean {
        const gl = this.context.gl;
        if (!this.texture) {
            this.texture = gl.createTexture();
            if (!this.texture) return false;
        }
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        if (this.uploaded === source) return true;
        if (this.textureWidth !== source.width || this.textureHeight !== source.height) {
            gl.texImage2D(
                gl.TEXTURE_2D,
                0,
                gl.RGBA8,
                source.width,
                source.height,
                0,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                source.data,
            );
            this.textureWidth = source.width;
            this.textureHeight = source.height;
        } else {
            gl.texSubImage2D(
                gl.TEXTURE_2D,
                0,
                0,
                0,
                source.width,
                source.height,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                source.data,
            );
        }
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.generateMipmap(gl.TEXTURE_2D);
        this.uploaded = source;
        return true;
    }
}

function columnMajor(m: Mat3): Float32Array {
    return new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
}

class RoutedWarpBackend extends RoutedBackend<WarpBackend> implements WarpBackend {
    warp(request: WarpRequest): WarpResult | null {
        return this.route(request.width * request.height, (backend) => backend.warp(request));
    }
}

function calibrationRequest(side: number): WarpRequest {
    const sourceWidth = 640;
    const sourceHeight = 480;
    const source: ColorImage = {
        width: sourceWidth,
        height: sourceHeight,
        data: new Uint8ClampedArray(
            sourceWidth * sourceHeight * 4,
        ) as Uint8ClampedArray<ArrayBuffer>,
    };
    for (let y = 0; y < sourceHeight; y++) {
        for (let x = 0; x < sourceWidth; x++) {
            const i = (y * sourceWidth + x) * 4;
            const block = ((x >> 4) + (y >> 4)) % 2 === 0 ? 60 : 200;
            source.data[i] = block;
            source.data[i + 1] = (x * 5) % 256;
            source.data[i + 2] = (y * 7) % 256;
            source.data[i + 3] = 255;
        }
    }
    const canvas = side * 2;
    const geometry: CanvasGeometry = {
        surface: 'planar',
        width: canvas,
        height: canvas,
        focal: canvas / 2.4,
        orientation: mat3Identity(),
        orientationInverse: mat3Identity(),
        planarScale: canvas / 2.4,
        cylinderHalfHeight: Math.PI / 3,
    };
    return {
        geometry,
        rotation: mat3Identity(),
        source,
        focal: canvas / 2.4,
        distortion: -0.08,
        vignetting: -0.2,
        gain: UNIT_RGB,
        feather: 16,
        u0: Math.round((canvas - side) / 2),
        v0: Math.round((canvas - side) / 2),
        width: side,
        height: side,
    };
}

const warpCalibration: Calibration<WarpBackend> = {
    cpu: cpuWarpBackend,
    workloads: CALIBRATION_SIDES.map((side) => side * side),
    createGpu: (context) => GpuWarpBackend.create(context),
    agrees(gpu, cpu, workload) {
        const request = calibrationRequest(Math.round(Math.sqrt(workload)));
        const expected = cpu.warp(request);
        const actual = gpu.warp(request);
        if (!expected || !actual || expected.pixels === 0) return false;
        let error = 0;
        for (let i = 0; i < expected.color.length; i++) {
            error += Math.abs(expected.color[i] - actual.color[i]);
        }
        let maskError = 0;
        for (let i = 0; i < expected.mask.length; i++) {
            maskError += Math.abs(expected.mask[i] - actual.mask[i]);
        }
        return (
            error / expected.color.length < AGREEMENT_TOLERANCE &&
            maskError / expected.mask.length < 0.02
        );
    },
    run: (backend, workload) =>
        backend.warp(calibrationRequest(Math.round(Math.sqrt(workload)))) !== null,
    route: (gpu, cpu, threshold) => new RoutedWarpBackend(gpu, cpu, threshold),
    describeWorkload: (workload) => `${Math.round(Math.sqrt(workload))}² px`,
};

export function createWarpSelector(): BackendSelector<WarpBackend> {
    return new BackendSelector(warpCalibration);
}
