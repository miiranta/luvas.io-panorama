import { jacobiEigen } from '../../foundation/math/jacobi-eigen';
import { Mat3, mat3Identity } from '../../foundation/math/matrix3';
import { opticalAxis } from '../../foundation/math/rotation';

const MIN_CAMERAS = 3;
const DEGENERATE_SPREAD = 1e-3;

export function levelHorizon(rotations: readonly Mat3[]): Mat3 {
    if (rotations.length < MIN_CAMERAS) return mat3Identity();
    const covariance = new Float64Array(9);
    const down = [0, 0, 0];
    for (const rotation of rotations) {
        const x = [rotation[0], rotation[1], rotation[2]];
        for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 3; c++) covariance[r * 3 + c] += x[r] * x[c];
            down[r] += rotation[3 + r];
        }
    }
    const { values, vectors } = jacobiEigen(covariance, 3);
    const order = [0, 1, 2].sort((a, b) => values[a] - values[b]);
    const total = values[0] + values[1] + values[2];
    const degenerate = values[order[1]] < DEGENERATE_SPREAD * total;
    const up = normalize(
        degenerate ? down : [vectors[order[0]], vectors[3 + order[0]], vectors[6 + order[0]]],
    );
    if (!up) return mat3Identity();
    if (up[0] * down[0] + up[1] * down[1] + up[2] * down[2] < 0) {
        for (let i = 0; i < 3; i++) up[i] = -up[i];
    }
    const centre = opticalAxis(rotations[Math.floor(rotations.length / 2)]);
    const along = centre[0] * up[0] + centre[1] * up[1] + centre[2] * up[2];
    const forward = normalize(
        centre.map((value, i) => value - up[i] * along),
        1e-6,
    );
    if (!forward) return mat3Identity();
    const right = [
        up[1] * forward[2] - up[2] * forward[1],
        up[2] * forward[0] - up[0] * forward[2],
        up[0] * forward[1] - up[1] * forward[0],
    ];
    const m = new Float64Array(9) as Mat3;
    for (let row = 0; row < 3; row++) {
        m[row * 3] = right[row];
        m[row * 3 + 1] = up[row];
        m[row * 3 + 2] = forward[row];
    }
    return m;
}

function normalize(vector: number[], epsilon = 1e-9): number[] | null {
    const norm = Math.hypot(vector[0], vector[1], vector[2]);
    return norm < epsilon ? null : vector.map((value) => value / norm);
}
