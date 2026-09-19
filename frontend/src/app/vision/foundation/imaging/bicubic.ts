export interface BicubicTaps {
    columns: Int32Array;
    rows: Int32Array;
    weightsX: Float64Array;
    weightsY: Float64Array;
}

export function createBicubicTaps(): BicubicTaps {
    return {
        columns: new Int32Array(4),
        rows: new Int32Array(4),
        weightsX: new Float64Array(4),
        weightsY: new Float64Array(4),
    };
}

function keysWeights(t: number, weights: Float64Array): void {
    const t2 = t * t;
    const t3 = t2 * t;
    weights[0] = -0.5 * t3 + t2 - 0.5 * t;
    weights[1] = 1.5 * t3 - 2.5 * t2 + 1;
    weights[2] = -1.5 * t3 + 2 * t2 + 0.5 * t;
    weights[3] = 0.5 * t3 - 0.5 * t2;
}

function clampedIndices(origin: number, size: number, indices: Int32Array): void {
    for (let k = 0; k < 4; k++) indices[k] = Math.min(size - 1, Math.max(0, origin + k - 1));
}

export function bicubicTaps(
    width: number,
    height: number,
    x: number,
    y: number,
    taps: BicubicTaps,
): BicubicTaps {
    const cx = Math.min(width - 1, Math.max(0, x));
    const cy = Math.min(height - 1, Math.max(0, y));
    const x0 = Math.floor(cx);
    const y0 = Math.floor(cy);
    clampedIndices(x0, width, taps.columns);
    clampedIndices(y0, height, taps.rows);
    keysWeights(cx - x0, taps.weightsX);
    keysWeights(cy - y0, taps.weightsY);
    return taps;
}

export function sampleBicubic(
    data: ArrayLike<number>,
    taps: BicubicTaps,
    width: number,
    channels = 1,
    channel = 0,
): number {
    const { columns, rows, weightsX, weightsY } = taps;
    let sum = 0;
    for (let j = 0; j < 4; j++) {
        const row = rows[j] * width;
        let line = 0;
        for (let i = 0; i < 4; i++)
            line += data[(row + columns[i]) * channels + channel] * weightsX[i];
        sum += line * weightsY[j];
    }
    return sum;
}
