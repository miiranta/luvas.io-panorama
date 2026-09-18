import { Mat3, mat3Multiply } from '../math/matrix3';
import { nearestRotation, rotationFromAxisAngle } from '../math/so3';
import { solveLinearSystem } from '../math/decomposition';
import { homographyFromRotations } from './rotational-camera';

export interface BundleObservation {
    cameraA: number;
    cameraB: number;
    ax: number;
    ay: number;
    bx: number;
    by: number;
}

export interface BundleProblem {
    rotations: Mat3[];
    focal: number;
    cx: number;
    cy: number;
    observations: readonly BundleObservation[];
    freeCameras: readonly number[];
    refineFocal: boolean;
    iterations: number;
}

export interface BundleResult {
    rotations: Mat3[];
    focal: number;
    initialError: number;
    finalError: number;
}

interface ObservationGroup {
    cameraA: number;
    cameraB: number;
    indices: number[];
}

function groupObservations(observations: readonly BundleObservation[]): ObservationGroup[] {
    const groups = new Map<string, ObservationGroup>();
    observations.forEach((observation, index) => {
        const key = `${observation.cameraA}:${observation.cameraB}`;
        const existing = groups.get(key);
        if (existing) {
            existing.indices.push(index);
        } else {
            groups.set(key, {
                cameraA: observation.cameraA,
                cameraB: observation.cameraB,
                indices: [index],
            });
        }
    });
    return [...groups.values()];
}

function residuals(
    rotations: Mat3[],
    focal: number,
    cx: number,
    cy: number,
    observations: readonly BundleObservation[],
    groups: readonly ObservationGroup[],
    out: Float64Array,
): number {
    let sum = 0;
    for (const group of groups) {
        const h = homographyFromRotations(
            rotations[group.cameraB],
            rotations[group.cameraA],
            focal,
            cx,
            cy,
        );
        for (const index of group.indices) {
            const o = observations[index];
            const w = h[6] * o.ax + h[7] * o.ay + h[8];
            let ex = 0;
            let ey = 0;
            if (Math.abs(w) < 1e-9) {
                ex = 1e3;
                ey = 1e3;
            } else {
                ex = (h[0] * o.ax + h[1] * o.ay + h[2]) / w - o.bx;
                ey = (h[3] * o.ax + h[4] * o.ay + h[5]) / w - o.by;
            }
            out[index * 2] = ex;
            out[index * 2 + 1] = ey;
            sum += ex * ex + ey * ey;
        }
    }
    return sum;
}

export class BundleAdjuster {
    solve(problem: BundleProblem): BundleResult {
        const { observations, cx, cy, freeCameras, refineFocal, iterations } = problem;
        const rotations = problem.rotations.map((r) => Float64Array.from(r) as Mat3);
        let focal = problem.focal;
        const paramCount = freeCameras.length * 3 + (refineFocal ? 1 : 0);
        const residualCount = observations.length * 2;
        const groups = groupObservations(observations);
        const current = new Float64Array(residualCount);
        let error = residuals(rotations, focal, cx, cy, observations, groups, current);
        const initialError = residualCount === 0 ? 0 : Math.sqrt(error / (residualCount / 2));
        if (paramCount === 0 || residualCount < paramCount || iterations === 0) {
            return {
                rotations,
                focal,
                initialError,
                finalError: initialError,
            };
        }
        const jacobian = new Float64Array(residualCount * paramCount);
        const trial = new Float64Array(residualCount);
        let lambda = 1e-3;
        for (let iter = 0; iter < iterations; iter++) {
            for (let p = 0; p < paramCount; p++) {
                const isFocal = refineFocal && p === paramCount - 1;
                const step = isFocal ? Math.max(0.5, focal * 1e-4) : 1e-5;
                const nextRotations = rotations.map((r) => Float64Array.from(r) as Mat3);
                let nextFocal = focal;
                if (isFocal) {
                    nextFocal = focal + step;
                } else {
                    const camera = freeCameras[Math.floor(p / 3)];
                    const axis = p % 3;
                    const delta = [0, 0, 0];
                    delta[axis] = step;
                    nextRotations[camera] = mat3Multiply(
                        rotationFromAxisAngle(delta[0], delta[1], delta[2]),
                        nextRotations[camera],
                    );
                }
                residuals(nextRotations, nextFocal, cx, cy, observations, groups, trial);
                for (let r = 0; r < residualCount; r++) {
                    jacobian[r * paramCount + p] = (trial[r] - current[r]) / step;
                }
            }
            const jtj = new Float64Array(paramCount * paramCount);
            const jtr = new Float64Array(paramCount);
            for (let r = 0; r < residualCount; r++) {
                const base = r * paramCount;
                for (let a = 0; a < paramCount; a++) {
                    const ja = jacobian[base + a];
                    if (ja === 0) continue;
                    for (let b = 0; b < paramCount; b++)
                        jtj[a * paramCount + b] += ja * jacobian[base + b];
                    jtr[a] -= ja * current[r];
                }
            }
            let improved = false;
            for (let attempt = 0; attempt < 6 && !improved; attempt++) {
                const damped = Float64Array.from(jtj);
                for (let a = 0; a < paramCount; a++) damped[a * paramCount + a] *= 1 + lambda;
                for (let a = 0; a < paramCount; a++) damped[a * paramCount + a] += lambda * 1e-9;
                const delta = solveLinearSystem(damped, jtr, paramCount);
                if (!delta) {
                    lambda *= 10;
                    continue;
                }
                const candidateRotations = rotations.map((r) => Float64Array.from(r) as Mat3);
                let candidateFocal = focal;
                for (let c = 0; c < freeCameras.length; c++) {
                    const camera = freeCameras[c];
                    candidateRotations[camera] = nearestRotation(
                        mat3Multiply(
                            rotationFromAxisAngle(delta[c * 3], delta[c * 3 + 1], delta[c * 3 + 2]),
                            candidateRotations[camera],
                        ),
                    );
                }
                if (refineFocal) {
                    candidateFocal = Math.max(60, focal + delta[paramCount - 1]);
                }
                const candidateError = residuals(
                    candidateRotations,
                    candidateFocal,
                    cx,
                    cy,
                    observations,
                    groups,
                    trial,
                );
                if (candidateError < error) {
                    for (let i = 0; i < rotations.length; i++) rotations[i] = candidateRotations[i];
                    focal = candidateFocal;
                    error = candidateError;
                    current.set(trial);
                    lambda = Math.max(1e-9, lambda * 0.4);
                    improved = true;
                } else {
                    lambda *= 8;
                }
            }
            if (!improved) break;
        }
        return {
            rotations,
            focal,
            initialError,
            finalError: Math.sqrt(error / (residualCount / 2)),
        };
    }
}
