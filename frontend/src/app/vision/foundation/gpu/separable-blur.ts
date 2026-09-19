import { GlContext, GlProgram, GlTarget } from './gl-context';

const MAX_RADIUS = 128;

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D uSource;
uniform vec2 uStep;
uniform float uSigma;
uniform int uRadius;
in vec2 vUv;
out vec4 fragColor;
void main() {
    vec4 total = vec4(0.0);
    float weightSum = 0.0;
    float denom = 2.0 * uSigma * uSigma;
    for (int i = 0; i <= ${2 * MAX_RADIUS}; i++) {
        int tap = i - uRadius;
        if (tap > uRadius) break;
        float offset = float(tap);
        float weight = exp(-(offset * offset) / denom);
        total += texture(uSource, vUv + uStep * offset) * weight;
        weightSum += weight;
    }
    fragColor = total / max(weightSum, 1e-6);
}`;

export class SeparableBlur {
    private constructor(
        private readonly context: GlContext,
        private readonly program: GlProgram,
    ) {}

    static create(context: GlContext): SeparableBlur | null {
        const program = context.program(FRAGMENT, ['uSource', 'uStep', 'uSigma', 'uRadius']);
        return program ? new SeparableBlur(context, program) : null;
    }

    apply(input: WebGLTexture, sigma: number, scratch: GlTarget, output: GlTarget): void {
        const { width, height } = output;
        const radius = Math.min(MAX_RADIUS, Math.max(1, Math.ceil(sigma * 3)));
        this.pass(input, scratch, sigma, radius, 1 / width, 0);
        this.pass(scratch.texture, output, sigma, radius, 0, 1 / height);
    }

    private pass(
        input: WebGLTexture,
        target: GlTarget,
        sigma: number,
        radius: number,
        stepX: number,
        stepY: number,
    ): void {
        const gl = this.context.gl;
        const uniforms = this.program.uniforms;
        this.context.draw(this.program, target, target.width, target.height, () => {
            this.context.bindInput(0, input, uniforms['uSource']);
            gl.uniform1f(uniforms['uSigma'], sigma);
            gl.uniform1i(uniforms['uRadius'], radius);
            gl.uniform2f(uniforms['uStep'], stepX, stepY);
        });
    }
}
