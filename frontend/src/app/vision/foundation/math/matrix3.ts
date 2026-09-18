export type Mat3 = Float64Array;

export function mat3Identity(): Mat3 {
    const m = new Float64Array(9);
    m[0] = 1;
    m[4] = 1;
    m[8] = 1;
    return m;
}

export function mat3Multiply(a: Mat3, b: Mat3): Mat3 {
    const m = new Float64Array(9);
    for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
            let s = 0;
            for (let k = 0; k < 3; k++) s += a[r * 3 + k] * b[k * 3 + c];
            m[r * 3 + c] = s;
        }
    }
    return m;
}

export function mat3MultiplyTransposed(a: Mat3, b: Mat3, out: Mat3 = new Float64Array(9)): Mat3 {
    for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
            let s = 0;
            for (let k = 0; k < 3; k++) s += a[r * 3 + k] * b[c * 3 + k];
            out[r * 3 + c] = s;
        }
    }
    return out;
}

export function mat3Transpose(a: Mat3): Mat3 {
    const m = new Float64Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m[c * 3 + r] = a[r * 3 + c];
    return m;
}

export function mat3Determinant(a: Mat3): number {
    return (
        a[0] * (a[4] * a[8] - a[5] * a[7]) -
        a[1] * (a[3] * a[8] - a[5] * a[6]) +
        a[2] * (a[3] * a[7] - a[4] * a[6])
    );
}

export function mat3Inverse(a: Mat3): Mat3 | null {
    const det = mat3Determinant(a);
    if (!isFinite(det) || Math.abs(det) < 1e-14) return null;
    const inv = 1 / det;
    const m = new Float64Array(9);
    m[0] = (a[4] * a[8] - a[5] * a[7]) * inv;
    m[1] = (a[2] * a[7] - a[1] * a[8]) * inv;
    m[2] = (a[1] * a[5] - a[2] * a[4]) * inv;
    m[3] = (a[5] * a[6] - a[3] * a[8]) * inv;
    m[4] = (a[0] * a[8] - a[2] * a[6]) * inv;
    m[5] = (a[2] * a[3] - a[0] * a[5]) * inv;
    m[6] = (a[3] * a[7] - a[4] * a[6]) * inv;
    m[7] = (a[1] * a[6] - a[0] * a[7]) * inv;
    m[8] = (a[0] * a[4] - a[1] * a[3]) * inv;
    return m;
}
