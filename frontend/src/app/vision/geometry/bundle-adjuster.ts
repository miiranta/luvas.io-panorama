import { Mat3, mat3Multiply } from '../math/matrix3';
import { nearestRotation, rotationFromAxisAngle } from '../math/so3';
import { solveLinearSystem } from '../math/decomposition';

const HUBER_SIGMA = 2;
const ANGLE_PRIOR = Math.PI / 16;
const FOCAL_PRIOR_FRACTION = 0.1;
const MIN_FOCAL = 60;
const MAX_ATTEMPTS = 6;

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

interface Projection {
    x: number;
    y: number;
    z: number;
    vx: number;
    vy: number;
    vz: number;
    wx: number;
    wy: number;
    valid: boolean;
}

function cross(ax: number, ay: number, az: number, axis: number, out: Float64Array): void {
    if (axis === 0) {
        out[0] = 0;
        out[1] = -az;
        out[2] = ay;
        return;
    }
    if (axis === 1) {
        out[0] = az;
        out[1] = 0;
        out[2] = -ax;
        return;
    }
    out[0] = -ay;
    out[1] = ax;
    out[2] = 0;
}

export class BundleAdjuster {
    private focal = 1;
    private cx = 0;
    private cy = 0;
    private rotations: Mat3[] = [];
    private observations: readonly BundleObservation[] = [];
    private freeSlot = new Int32Array(0);
    private paramCount = 0;
    private focalParam = -1;
    private residuals = new Float64Array(0);
    private weights = new Float64Array(0);
    private jacobian = new Float64Array(0);
    private readonly relative = new Float64Array(9);
    private readonly projection: Projection = {
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        wx: 0,
        wy: 0,
        valid: false,
    };
    private readonly scratch = new Float64Array(3);

    solve(problem: BundleProblem): BundleResult {
        const { observations, cx, cy, freeCameras, refineFocal, iterations } = problem;
        const rotations = problem.rotations.map((r) => Float64Array.from(r) as Mat3);
        this.rotations = rotations;
        this.observations = observations;
        this.focal = problem.focal;
        this.cx = cx;
        this.cy = cy;
        this.freeSlot = new Int32Array(rotations.length).fill(-1);
        const free = [...new Set(freeCameras)].filter(
            (camera) => camera >= 0 && camera < rotations.length,
        );
        free.forEach((camera, slot) => {
            this.freeSlot[camera] = slot * 3;
        });
        this.paramCount = free.length * 3 + (refineFocal ? 1 : 0);
        this.focalParam = refineFocal ? free.length * 3 : -1;

        const residualCount = observations.length * 4;
        if (this.residuals.length !== residualCount) {
            this.residuals = new Float64Array(residualCount);
            this.weights = new Float64Array(residualCount);
        }
        let cost = this.evaluate(rotations, this.focal);
        const initialError = this.rootMeanSquare();
        if (this.paramCount === 0 || residualCount < this.paramCount || iterations === 0) {
            return { rotations, focal: this.focal, initialError, finalError: initialError };
        }
        if (this.jacobian.length !== residualCount * this.paramCount) {
            this.jacobian = new Float64Array(residualCount * this.paramCount);
        }

        let lambda = 1e-3;
        for (let iteration = 0; iteration < iterations; iteration++) {
            this.buildJacobian(rotations, this.focal);
            const normal = new Float64Array(this.paramCount * this.paramCount);
            const gradient = new Float64Array(this.paramCount);
            for (let r = 0; r < residualCount; r++) {
                const weight = this.weights[r];
                if (weight === 0) continue;
                const base = r * this.paramCount;
                for (let a = 0; a < this.paramCount; a++) {
                    const ja = this.jacobian[base + a];
                    if (ja === 0) continue;
                    const weighted = weight * ja;
                    for (let b = a; b < this.paramCount; b++) {
                        normal[a * this.paramCount + b] += weighted * this.jacobian[base + b];
                    }
                    gradient[a] -= weighted * this.residuals[r];
                }
            }
            for (let a = 0; a < this.paramCount; a++) {
                for (let b = 0; b < a; b++) {
                    normal[a * this.paramCount + b] = normal[b * this.paramCount + a];
                }
            }
            const prior = this.priorDiagonal();
            let improved = false;
            for (let attempt = 0; attempt < MAX_ATTEMPTS && !improved; attempt++) {
                const damped = Float64Array.from(normal);
                for (let a = 0; a < this.paramCount; a++) {
                    damped[a * this.paramCount + a] += lambda * prior[a];
                }
                const delta = solveLinearSystem(damped, gradient, this.paramCount);
                if (!delta) {
                    lambda *= 10;
                    continue;
                }
                const candidate = rotations.map((r) => Float64Array.from(r) as Mat3);
                for (let camera = 0; camera < candidate.length; camera++) {
                    const slot = this.freeSlot[camera];
                    if (slot < 0) continue;
                    candidate[camera] = nearestRotation(
                        mat3Multiply(
                            rotationFromAxisAngle(delta[slot], delta[slot + 1], delta[slot + 2]),
                            candidate[camera],
                        ),
                    );
                }
                const candidateFocal =
                    this.focalParam >= 0
                        ? Math.max(MIN_FOCAL, this.focal + delta[this.focalParam])
                        : this.focal;
                const candidateCost = this.evaluate(candidate, candidateFocal);
                if (candidateCost < cost) {
                    for (let i = 0; i < rotations.length; i++) rotations[i] = candidate[i];
                    this.focal = candidateFocal;
                    cost = candidateCost;
                    lambda = Math.max(1e-9, lambda * 0.4);
                    improved = true;
                } else {
                    this.evaluate(rotations, this.focal);
                    lambda *= 8;
                }
            }
            if (!improved) break;
        }
        return {
            rotations,
            focal: this.focal,
            initialError,
            finalError: this.rootMeanSquare(),
        };
    }

    private priorDiagonal(): Float64Array {
        const prior = new Float64Array(this.paramCount).fill(1 / (ANGLE_PRIOR * ANGLE_PRIOR));
        if (this.focalParam >= 0) {
            const sigma = Math.max(1, this.focal * FOCAL_PRIOR_FRACTION);
            prior[this.focalParam] = 1 / (sigma * sigma);
        }
        return prior;
    }

    private evaluate(rotations: Mat3[], focal: number): number {
        let cost = 0;
        this.observations.forEach((observation, index) => {
            const base = index * 4;
            cost += this.residualPair(
                rotations,
                focal,
                observation.cameraA,
                observation.cameraB,
                observation.bx,
                observation.by,
                observation.ax,
                observation.ay,
                base,
            );
            cost += this.residualPair(
                rotations,
                focal,
                observation.cameraB,
                observation.cameraA,
                observation.ax,
                observation.ay,
                observation.bx,
                observation.by,
                base + 2,
            );
        });
        return cost;
    }

    private residualPair(
        rotations: Mat3[],
        focal: number,
        target: number,
        source: number,
        sx: number,
        sy: number,
        tx: number,
        ty: number,
        slot: number,
    ): number {
        const projected = this.project(rotations, focal, target, source, sx, sy);
        if (!projected.valid) {
            this.residuals[slot] = 0;
            this.residuals[slot + 1] = 0;
            this.weights[slot] = 0;
            this.weights[slot + 1] = 0;
            return 4 * HUBER_SIGMA * HUBER_SIGMA;
        }
        const ex = projected.x / projected.z - tx;
        const ey = projected.y / projected.z - ty;
        this.residuals[slot] = ex;
        this.residuals[slot + 1] = ey;
        const distance = Math.hypot(ex, ey);
        const weight = distance <= HUBER_SIGMA ? 1 : HUBER_SIGMA / distance;
        this.weights[slot] = weight;
        this.weights[slot + 1] = weight;
        return distance <= HUBER_SIGMA
            ? distance * distance
            : 2 * HUBER_SIGMA * distance - HUBER_SIGMA * HUBER_SIGMA;
    }

    private project(
        rotations: Mat3[],
        focal: number,
        target: number,
        source: number,
        sx: number,
        sy: number,
    ): Projection {
        const out = this.projection;
        const a = rotations[target];
        const b = rotations[source];
        if (!a || !b) {
            out.valid = false;
            return out;
        }
        const m = this.relative;
        for (let row = 0; row < 3; row++) {
            for (let col = 0; col < 3; col++) {
                m[row * 3 + col] =
                    a[row * 3] * b[col * 3] +
                    a[row * 3 + 1] * b[col * 3 + 1] +
                    a[row * 3 + 2] * b[col * 3 + 2];
            }
        }
        const wx = (sx - this.cx) / focal;
        const wy = (sy - this.cy) / focal;
        const vx = m[0] * wx + m[1] * wy + m[2];
        const vy = m[3] * wx + m[4] * wy + m[5];
        const vz = m[6] * wx + m[7] * wy + m[8];
        out.wx = wx;
        out.wy = wy;
        out.vx = vx;
        out.vy = vy;
        out.vz = vz;
        out.x = focal * vx + this.cx * vz;
        out.y = focal * vy + this.cy * vz;
        out.z = vz;
        out.valid = vz > 1e-6;
        return out;
    }

    private buildJacobian(rotations: Mat3[], focal: number): void {
        this.jacobian.fill(0);
        this.observations.forEach((observation, index) => {
            const base = index * 4;
            this.jacobianPair(
                rotations,
                focal,
                observation.cameraA,
                observation.cameraB,
                observation.bx,
                observation.by,
                base,
            );
            this.jacobianPair(
                rotations,
                focal,
                observation.cameraB,
                observation.cameraA,
                observation.ax,
                observation.ay,
                base + 2,
            );
        });
    }

    private jacobianPair(
        rotations: Mat3[],
        focal: number,
        target: number,
        source: number,
        sx: number,
        sy: number,
        slot: number,
    ): void {
        const projected = this.project(rotations, focal, target, source, sx, sy);
        if (!projected.valid) return;
        const { x, y, z, vx, vy, vz, wx, wy } = projected;
        const invZ = 1 / z;
        const dpx = [invZ, 0, -x * invZ * invZ];
        const dpy = [0, invZ, -y * invZ * invZ];
        const rowX = slot * this.paramCount;
        const rowY = (slot + 1) * this.paramCount;
        const write = (param: number, dx: number, dy: number, dz: number): void => {
            this.jacobian[rowX + param] = dpx[0] * dx + dpx[1] * dy + dpx[2] * dz;
            this.jacobian[rowY + param] = dpy[0] * dx + dpy[1] * dy + dpy[2] * dz;
        };
        const targetSlot = this.freeSlot[target];
        if (targetSlot >= 0) {
            for (let axis = 0; axis < 3; axis++) {
                cross(vx, vy, vz, axis, this.scratch);
                write(
                    targetSlot + axis,
                    focal * this.scratch[0] + this.cx * this.scratch[2],
                    focal * this.scratch[1] + this.cy * this.scratch[2],
                    this.scratch[2],
                );
            }
        }
        const sourceSlot = this.freeSlot[source];
        if (sourceSlot >= 0) {
            const m = this.relative;
            for (let axis = 0; axis < 3; axis++) {
                cross(wx, wy, 1, axis, this.scratch);
                const ex = this.scratch[0];
                const ey = this.scratch[1];
                const ez = this.scratch[2];
                const mx = -(m[0] * ex + m[1] * ey + m[2] * ez);
                const my = -(m[3] * ex + m[4] * ey + m[5] * ez);
                const mz = -(m[6] * ex + m[7] * ey + m[8] * ez);
                write(sourceSlot + axis, focal * mx + this.cx * mz, focal * my + this.cy * mz, mz);
            }
        }
        if (this.focalParam >= 0) {
            const m = this.relative;
            const dwx = -wx / focal;
            const dwy = -wy / focal;
            const dvx = m[0] * dwx + m[1] * dwy;
            const dvy = m[3] * dwx + m[4] * dwy;
            const dvz = m[6] * dwx + m[7] * dwy;
            write(
                this.focalParam,
                vx + focal * dvx + this.cx * dvz,
                vy + focal * dvy + this.cy * dvz,
                dvz,
            );
        }
    }

    private rootMeanSquare(): number {
        const points = this.observations.length * 2;
        if (points === 0) return 0;
        let sum = 0;
        for (let i = 0; i < this.residuals.length; i += 2) {
            sum +=
                this.residuals[i] * this.residuals[i] +
                this.residuals[i + 1] * this.residuals[i + 1];
        }
        return Math.sqrt(sum / points);
    }
}
