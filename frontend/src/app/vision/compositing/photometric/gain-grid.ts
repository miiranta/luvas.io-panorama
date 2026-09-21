export const GAIN_COLUMNS = 8;
export const GAIN_ROWS = 6;
export const GAIN_CELLS = GAIN_COLUMNS * GAIN_ROWS;

export interface GainGrid {
    columns: number;
    rows: number;
    values: Float32Array;
}

function clamp(value: number, low: number, high: number): number {
    return Math.min(high, Math.max(low, value));
}

export function gainCell(x: number, y: number, width: number, height: number): number {
    const column = clamp(Math.floor(((x + 0.5) / width) * GAIN_COLUMNS), 0, GAIN_COLUMNS - 1);
    const row = clamp(Math.floor(((y + 0.5) / height) * GAIN_ROWS), 0, GAIN_ROWS - 1);
    return row * GAIN_COLUMNS + column;
}

export function sampleGainGrid(
    grid: GainGrid,
    x: number,
    y: number,
    width: number,
    height: number,
): number {
    const { columns, rows, values } = grid;
    const gx = clamp(((x + 0.5) / width) * columns - 0.5, 0, columns - 1);
    const gy = clamp(((y + 0.5) / height) * rows - 0.5, 0, rows - 1);
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const x1 = Math.min(columns - 1, x0 + 1);
    const y1 = Math.min(rows - 1, y0 + 1);
    const fx = gx - x0;
    const fy = gy - y0;
    const top = values[y0 * columns + x0] * (1 - fx) + values[y0 * columns + x1] * fx;
    const bottom = values[y1 * columns + x0] * (1 - fx) + values[y1 * columns + x1] * fx;
    return top * (1 - fy) + bottom * fy;
}

export function smoothGainGrid(
    values: ArrayLike<number>,
    columns: number,
    rows: number,
    iterations: number,
): Float32Array {
    let current = Float32Array.from(values);
    for (let iteration = 0; iteration < iterations; iteration++) {
        const next = new Float32Array(current.length);
        for (let row = 0; row < rows; row++) {
            for (let column = 0; column < columns; column++) {
                let sum = 0;
                let count = 0;
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const y = row + dy;
                        const x = column + dx;
                        if (x < 0 || y < 0 || x >= columns || y >= rows) continue;
                        sum += current[y * columns + x];
                        count++;
                    }
                }
                next[row * columns + column] = sum / count;
            }
        }
        current = next;
    }
    return current;
}

export function gainGridsDiffer(
    a: GainGrid | null,
    b: GainGrid | null,
    tolerance: number,
): boolean {
    if (a === b) return false;
    if (!a || !b) return true;
    if (a.values.length !== b.values.length) return true;
    for (let i = 0; i < a.values.length; i++) {
        if (Math.abs(a.values[i] - b.values[i]) > tolerance) return true;
    }
    return false;
}
