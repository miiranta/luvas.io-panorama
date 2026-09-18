export function jacobiEigen(
    input: Float64Array,
    n: number,
): { values: Float64Array; vectors: Float64Array } {
    const a = Float64Array.from(input);
    const v = new Float64Array(n * n);
    for (let i = 0; i < n; i++) v[i * n + i] = 1;
    for (let sweep = 0; sweep < 100; sweep++) {
        let off = 0;
        for (let i = 0; i < n; i++)
            for (let j = i + 1; j < n; j++) off += a[i * n + j] * a[i * n + j];
        if (off < 1e-24) break;
        for (let p = 0; p < n; p++) {
            for (let q = p + 1; q < n; q++) {
                const apq = a[p * n + q];
                if (Math.abs(apq) < 1e-30) continue;
                const app = a[p * n + p];
                const aqq = a[q * n + q];
                const theta = (aqq - app) / (2 * apq);
                const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
                const c = 1 / Math.sqrt(t * t + 1);
                const s = t * c;
                for (let k = 0; k < n; k++) {
                    const akp = a[k * n + p];
                    const akq = a[k * n + q];
                    a[k * n + p] = c * akp - s * akq;
                    a[k * n + q] = s * akp + c * akq;
                }
                for (let k = 0; k < n; k++) {
                    const apk = a[p * n + k];
                    const aqk = a[q * n + k];
                    a[p * n + k] = c * apk - s * aqk;
                    a[q * n + k] = s * apk + c * aqk;
                }
                for (let k = 0; k < n; k++) {
                    const vkp = v[k * n + p];
                    const vkq = v[k * n + q];
                    v[k * n + p] = c * vkp - s * vkq;
                    v[k * n + q] = s * vkp + c * vkq;
                }
            }
        }
    }
    const values = new Float64Array(n);
    for (let i = 0; i < n; i++) values[i] = a[i * n + i];
    return { values, vectors: v };
}

export function smallestEigenvector(ata: Float64Array, n: number): Float64Array {
    const { values, vectors } = jacobiEigen(ata, n);
    let best = 0;
    for (let i = 1; i < n; i++) if (values[i] < values[best]) best = i;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = vectors[i * n + best];
    return out;
}

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
