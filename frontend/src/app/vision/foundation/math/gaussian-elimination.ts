export function solveLinearSystem(
    a: Float64Array,
    b: Float64Array,
    n: number,
): Float64Array | null {
    const m = Float64Array.from(a);
    const x = Float64Array.from(b);
    for (let col = 0; col < n; col++) {
        let pivot = col;
        for (let r = col + 1; r < n; r++) {
            if (Math.abs(m[r * n + col]) > Math.abs(m[pivot * n + col])) pivot = r;
        }
        if (Math.abs(m[pivot * n + col]) < 1e-14) return null;
        if (pivot !== col) {
            for (let c = 0; c < n; c++) {
                const tmp = m[col * n + c];
                m[col * n + c] = m[pivot * n + c];
                m[pivot * n + c] = tmp;
            }
            const tmp = x[col];
            x[col] = x[pivot];
            x[pivot] = tmp;
        }
        const inv = 1 / m[col * n + col];
        for (let r = col + 1; r < n; r++) {
            const factor = m[r * n + col] * inv;
            if (factor === 0) continue;
            for (let c = col; c < n; c++) m[r * n + c] -= factor * m[col * n + c];
            x[r] -= factor * x[col];
        }
    }
    const out = new Float64Array(n);
    for (let r = n - 1; r >= 0; r--) {
        let s = x[r];
        for (let c = r + 1; c < n; c++) s -= m[r * n + c] * out[c];
        out[r] = s / m[r * n + r];
    }
    return out;
}
