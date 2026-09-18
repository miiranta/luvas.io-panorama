const SOFTWARE_RENDERERS = /swiftshader|software|llvmpipe|basic render|microsoft basic/i;

const QUAD_VERTEX = `#version 300 es
in vec2 aPosition;
out vec2 vUv;
void main() {
    vUv = aPosition * 0.5 + 0.5;
    gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

export interface GlProgram {
    program: WebGLProgram;
    vao: WebGLVertexArrayObject;
    uniforms: Record<string, WebGLUniformLocation>;
}

export interface GlTarget {
    texture: WebGLTexture;
    framebuffer: WebGLFramebuffer;
    width: number;
    height: number;
}

export class GlContext {
    private static instance: GlContext | null | undefined;

    private constructor(
        readonly gl: WebGL2RenderingContext,
        private readonly quad: WebGLBuffer,
    ) {}

    static shared(): GlContext | null {
        if (GlContext.instance === undefined) GlContext.instance = GlContext.open();
        return GlContext.instance;
    }

    private static open(): GlContext | null {
        if (typeof OffscreenCanvas === 'undefined') return null;
        try {
            const gl = new OffscreenCanvas(4, 4).getContext('webgl2', {
                alpha: false,
                antialias: false,
                depth: false,
                stencil: false,
                premultipliedAlpha: false,
                powerPreference: 'high-performance',
            }) as WebGL2RenderingContext | null;
            if (!gl) return null;
            gl.disable(gl.DEPTH_TEST);
            gl.disable(gl.BLEND);
            const quad = gl.createBuffer();
            if (!quad) return null;
            gl.bindBuffer(gl.ARRAY_BUFFER, quad);
            gl.bufferData(
                gl.ARRAY_BUFFER,
                new Float32Array([-1, -1, 3, -1, -1, 3]),
                gl.STATIC_DRAW,
            );
            return new GlContext(gl, quad);
        } catch {
            return null;
        }
    }

    get rendererName(): string {
        const info = this.gl.getExtension('WEBGL_debug_renderer_info');
        return String(this.gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : this.gl.RENDERER));
    }

    get isSoftware(): boolean {
        return SOFTWARE_RENDERERS.test(this.rendererName);
    }

    get rendersFloat(): boolean {
        return this.gl.getExtension('EXT_color_buffer_float') !== null;
    }

    program(fragmentSource: string, uniformNames: readonly string[]): GlProgram | null {
        const gl = this.gl;
        const vertex = this.compile(gl.VERTEX_SHADER, QUAD_VERTEX);
        const fragment = this.compile(gl.FRAGMENT_SHADER, fragmentSource);
        if (!vertex || !fragment) return null;
        const program = gl.createProgram();
        if (!program) return null;
        gl.attachShader(program, vertex);
        gl.attachShader(program, fragment);
        gl.linkProgram(program);
        gl.deleteShader(vertex);
        gl.deleteShader(fragment);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
        const vao = gl.createVertexArray();
        if (!vao) return null;
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
        const location = gl.getAttribLocation(program, 'aPosition');
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);
        const uniforms: Record<string, WebGLUniformLocation> = {};
        for (const name of uniformNames) {
            const found = gl.getUniformLocation(program, name);
            if (!found) return null;
            uniforms[name] = found;
        }
        return { program, vao, uniforms };
    }

    floatTexture(width: number, height: number): WebGLTexture | null {
        return this.texture(width, height, this.gl.RGBA32F, this.gl.RGBA, this.gl.FLOAT);
    }

    byteTexture(width: number, height: number): WebGLTexture | null {
        return this.texture(width, height, this.gl.RGBA8, this.gl.RGBA, this.gl.UNSIGNED_BYTE);
    }

    uintTexture(width: number, height: number): WebGLTexture | null {
        return this.texture(
            width,
            height,
            this.gl.RGBA32UI,
            this.gl.RGBA_INTEGER,
            this.gl.UNSIGNED_INT,
        );
    }

    target(texture: WebGLTexture | null, width: number, height: number): GlTarget | null {
        const gl = this.gl;
        if (!texture) return null;
        const framebuffer = gl.createFramebuffer();
        if (!framebuffer) return null;
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return complete ? { texture, framebuffer, width, height } : null;
    }

    release(target: GlTarget | null): void {
        if (!target) return;
        this.gl.deleteTexture(target.texture);
        this.gl.deleteFramebuffer(target.framebuffer);
    }

    bindInput(unit: number, texture: WebGLTexture, uniform: WebGLUniformLocation): void {
        const gl = this.gl;
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.uniform1i(uniform, unit);
    }

    draw(
        program: GlProgram,
        target: GlTarget,
        width: number,
        height: number,
        bind: () => void,
    ): void {
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
        gl.viewport(0, 0, width, height);
        gl.useProgram(program.program);
        gl.bindVertexArray(program.vao);
        bind();
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindVertexArray(null);
    }

    finish(): boolean {
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return gl.getError() === gl.NO_ERROR;
    }

    private texture(
        width: number,
        height: number,
        internal: number,
        format: number,
        type: number,
    ): WebGLTexture | null {
        const gl = this.gl;
        const texture = gl.createTexture();
        if (!texture) return null;
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, type, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return texture;
    }

    private compile(type: number, source: string): WebGLShader | null {
        const gl = this.gl;
        const shader = gl.createShader(type);
        if (!shader) return null;
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return null;
        return shader;
    }
}
