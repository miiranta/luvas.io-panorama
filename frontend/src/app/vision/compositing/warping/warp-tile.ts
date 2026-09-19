export interface WarpTile {
    u0: number;
    v0: number;
    width: number;
    height: number;
    color: Float32Array;
    mask: Float32Array;
    pixels: number;
}

export function premultipliedTile(tile: WarpTile): Float32Array {
    const n = tile.width * tile.height;
    const data = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
        const mask = tile.mask[i];
        data[i * 4] = tile.color[i * 3] * mask;
        data[i * 4 + 1] = tile.color[i * 3 + 1] * mask;
        data[i * 4 + 2] = tile.color[i * 3 + 2] * mask;
        data[i * 4 + 3] = mask;
    }
    return data;
}
