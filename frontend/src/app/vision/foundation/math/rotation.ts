import {
    Mat3,
    mat3Determinant,
    mat3Identity,
    mat3Multiply,
    mat3MultiplyTransposed,
    mat3Transpose,
} from './matrix3';
import { toDegrees } from './angles';
import { jacobiEigen } from './jacobi-eigen';

export function nearestRotation(m: Mat3): Mat3 {
    const mt = mat3Transpose(m);
    const mtm = mat3Multiply(mt, m);
    const { values, vectors } = jacobiEigen(mtm, 3);
    const inv = new Float64Array(9);
    for (let i = 0; i < 3; i++) {
        const lambda = Math.max(values[i], 1e-18);
        const scale = 1 / Math.sqrt(lambda);
        for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 3; c++) {
                inv[r * 3 + c] += scale * vectors[r * 3 + i] * vectors[c * 3 + i];
            }
        }
    }
    const q = mat3Multiply(m, inv);
    if (mat3Determinant(q) < 0) for (let i = 0; i < 9; i++) q[i] = -q[i];
    return q;
}

export function rotationFromAxisAngle(rx: number, ry: number, rz: number): Mat3 {
    const theta = Math.hypot(rx, ry, rz);
    const m = mat3Identity();
    if (theta < 1e-12) return m;
    const kx = rx / theta;
    const ky = ry / theta;
    const kz = rz / theta;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const t = 1 - c;
    m[0] = c + kx * kx * t;
    m[1] = kx * ky * t - kz * s;
    m[2] = kx * kz * t + ky * s;
    m[3] = ky * kx * t + kz * s;
    m[4] = c + ky * ky * t;
    m[5] = ky * kz * t - kx * s;
    m[6] = kz * kx * t - ky * s;
    m[7] = kz * ky * t + kx * s;
    m[8] = c + kz * kz * t;
    return m;
}

export function rotationAngleBetween(a: Mat3, b: Mat3): number {
    const rel = mat3MultiplyTransposed(a, b);
    const trace = rel[0] + rel[4] + rel[8];
    const cos = Math.min(1, Math.max(-1, (trace - 1) / 2));
    return Math.acos(cos);
}

export function rotationDegreesBetween(a: Mat3, b: Mat3): number {
    return toDegrees(rotationAngleBetween(a, b));
}

export function opticalAxis(rotation: Mat3): [number, number, number] {
    return [rotation[6], rotation[7], rotation[8]];
}

export function pitchDegrees(rotation: Mat3): number {
    const [, y] = opticalAxis(rotation);
    return toDegrees(Math.asin(Math.min(1, Math.max(-1, y))));
}

export function yawDegrees(rotation: Mat3): number {
    const [x, , z] = opticalAxis(rotation);
    return toDegrees(Math.atan2(x, z));
}
