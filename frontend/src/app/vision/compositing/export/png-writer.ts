const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const IDAT_CHUNK = 1 << 20;

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(parts: readonly Uint8Array[]): number {
    let crc = 0xffffffff;
    for (const part of parts) {
        for (let i = 0; i < part.length; i++) crc = CRC_TABLE[(crc ^ part[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    const name = new Uint8Array([...type].map((c) => c.charCodeAt(0)));
    out.set(name, 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32([name, data]));
    return out;
}

function paeth(a: number, b: number, c: number): number {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    return pb <= pc ? b : c;
}

export class PngWriter {
    private readonly writer: WritableStreamDefaultWriter<BufferSource>;
    private readonly compressed: Promise<ArrayBuffer>;
    private readonly previous: Uint8Array;
    private rows = 0;

    constructor(
        readonly width: number,
        readonly height: number,
    ) {
        const stream = new CompressionStream('deflate');
        this.writer = stream.writable.getWriter();
        this.compressed = new Response(stream.readable).arrayBuffer();
        this.previous = new Uint8Array(width * 4);
    }

    async writeRows(rgba: Uint8ClampedArray | Uint8Array, count: number): Promise<void> {
        const stride = this.width * 4;
        const block = new Uint8Array(count * (stride + 1));
        let previous: ArrayLike<number> = this.previous;
        for (let row = 0; row < count; row++) {
            const offset = row * (stride + 1);
            block[offset] = 4;
            const source = row * stride;
            for (let i = 0; i < stride; i++) {
                const value = rgba[source + i];
                const left = i >= 4 ? rgba[source + i - 4] : 0;
                const up = previous[i];
                const upLeft = i >= 4 ? previous[i - 4] : 0;
                block[offset + 1 + i] = (value - paeth(left, up, upLeft)) & 0xff;
            }
            previous = rgba.subarray(source, source + stride);
        }
        if (count > 0) this.previous.set(previous);
        this.rows += count;
        await this.writer.ready;
        await this.writer.write(block);
    }

    async finish(): Promise<ArrayBuffer> {
        if (this.rows !== this.height) {
            throw new Error(`png expected ${this.height} rows, got ${this.rows}`);
        }
        await this.writer.close();
        const data = new Uint8Array(await this.compressed);
        const header = new Uint8Array(13);
        const view = new DataView(header.buffer);
        view.setUint32(0, this.width);
        view.setUint32(4, this.height);
        header[8] = 8;
        header[9] = 6;
        const parts: Uint8Array[] = [SIGNATURE, chunk('IHDR', header)];
        for (let offset = 0; offset < data.length; offset += IDAT_CHUNK) {
            parts.push(chunk('IDAT', data.subarray(offset, offset + IDAT_CHUNK)));
        }
        parts.push(chunk('IEND', new Uint8Array(0)));
        const total = parts.reduce((sum, part) => sum + part.length, 0);
        const out = new Uint8Array(total);
        let cursor = 0;
        for (const part of parts) {
            out.set(part, cursor);
            cursor += part.length;
        }
        return out.buffer;
    }
}
