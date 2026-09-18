import { Mat3, mat3Multiply } from '../math/matrix3';
import { nearestRotation, rotationFromAxisAngle } from '../math/so3';
import { solveLinearSystem } from '../math/decomposition';
import { MAX_DISTORTION, undistort } from './lens';

const HUBER_SIGMA = 2;
const ANGLE_PRIOR = Math.PI / 16;
const FOCAL_PRIOR_FRACTION = 0.1;
const DISTORTION_PRIOR = 0.1;
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
    distortion: number;
    cx: number;
    cy: number;
    observations: readonly BundleObservation[];
    freeCameras: readonly number[];
    refineFocal: boolean;
    refineDistortion: boolean;
    iterations: number;
}

export interface BundleResult {
    rotations: Mat3[];
    focal: number;
    distortion: number;
    initialError: number;
    finalError: number;
}

interface Projection {
    nx: number;
    ny: number;
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
    private distortion = 0;
    private cx = 0;
    private cy = 0;
    private observations: readonly BundleObservation[] = [];
    private freeSlot = new Int32Array(0);
    private paramCount = 0;
    private focalParam = -1;
    private distortionParam = -1;
    private residuals = new Float64Array(0);
    private weights = new Float64Array(0);
    private probePlus = new Float64Array(0);
    private probeMinus = new Float64Array(0);
    private jacobian = new Float64Array(0);
    private readonly relative = new Float64Array(9);
    private readonly projection: Projection = {
        nx: 0,
        ny: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        wx: 0,
        wy: 0,
        valid: false,
    };
    private readonly scratch = new Float64Array(3);
    private readonly lens = new Float64Array(2);

    solve(problem: BundleProblem): BundleResult {
        const { observations, cx, cy, freeCameras, iterations } = problem;
        const rotations = problem.rotations.map((r) => Float64Array.from(r) as Mat3);
        this.observations = observations;
        this.focal = problem.focal;
        this.distortion = problem.distortion;
        this.cx = cx;
        this.cy = cy;
        this.freeSlot = new Int32Array(rotations.length).fill(-1);
        const free = [...new Set(freeCameras)].filter(
            (camera) => camera >= 0 && camera < rotations.length,
        );
        free.forEach((camera, slot) => {
            this.freeSlot[camera] = slot * 3;
        });
        let next = free.length * 3;
        this.focalParam = problem.refineFocal ? next++ : -1;
        this.distortionParam = problem.refineDistortion ? next++ : -1;
        this.paramCount = next;

        const residualCount = observations.length * 4;
        if (this.residuals.length !== residualCount) {
            this.residuals = new Float64Array(residualCount);
            this.weights = new Float64Array(residualCount);
            this.probePlus = new Float64Array(residualCount);
            this.probeMinus = new Float64Array(residualCount);
        }
        let cost = this.evaluate(
            rotations,
            this.focal,
            this.distortion,
            this.residuals,
            this.weights,
        );
        const initialError = this.rootMeanSquare();
        const finish = (): BundleResult => ({
            rotations,
            focal: this.focal,
            distortion: this.distortion,
            initialError,
            finalError: this.rootMeanSquare(),
        });
        if (this.paramCount === 0 || residualCount < this.paramCount || iterations === 0) {
            return finish();
        }
        if (this.jacobian.length !== residualCount * this.paramCount) {
            this.jacobian = new Float64Array(residualCount * this.paramCount);
        }

        let lambda = 1e-3;
        for (let iteration = 0; iteration < iterations; iteration++) {
            this.buildJacobian(rotations);
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
                const candidateDistortion =
                    this.distortionParam >= 0
                        ? Math.min(
                              MAX_DISTORTION,
                              Math.max(
                                  -MAX_DISTORTION,
                                  this.distortion + delta[this.distortionParam],
                              ),
                          )
                        : this.distortion;
                const candidateCost = this.evaluate(
                    candidate,
                    candidateFocal,
                    candidateDistortion,
                    this.residuals,
                    this.weights,
                );
                if (candidateCost < cost) {
                    for (let i = 0; i < rotations.length; i++) rotations[i] = candidate[i];
                    this.focal = candidateFocal;
                    this.distortion = candidateDistortion;
                    cost = candidateCost;
                    lambda = Math.max(1e-9, lambda * 0.4);
                    improved = true;
                } else {
                    this.evaluate(
                        rotations,
                        this.focal,
                        this.distortion,
                        this.residuals,
                        this.weights,
                    );
                    lambda *= 8;
                }
            }
            if (!improved) break;
        }
        return finish();
    }

    private priorDiagonal(): Float64Array {
        const prior = new Float64Array(this.paramCount).fill(1 / (ANGLE_PRIOR * ANGLE_PRIOR));
        if (this.focalParam >= 0) {
            const sigma = Math.max(1, this.focal * FOCAL_PRIOR_FRACTION);
            prior[this.focalParam] = 1 / (sigma * sigma);
        }
        if (this.distortionParam >= 0) {
            prior[this.distortionParam] = 1 / (DISTORTION_PRIOR * DISTORTION_PRIOR);
        }
        return prior;
    }

    private evaluate(
        rotations: Mat3[],
        focal: number,
        distortion: number,
        residuals: Float64Array,
        weights: Float64Array | null,
    ): number {
        let cost = 0;
        this.observations.forEach((observation, index) => {
            const base = index * 4;
            cost += this.residualPair(
                rotations,
                focal,
                distortion,
                observation.cameraA,
                observation.cameraB,
                observation.bx,
                observation.by,
                observation.ax,
                observation.ay,
                base,
                residuals,
                weights,
            );
            cost += this.residualPair(
                rotations,
                focal,
                distortion,
                observation.cameraB,
                observation.cameraA,
                observation.ax,
                observation.ay,
                observation.bx,
                observation.by,
                base + 2,
                residuals,
                weights,
            );
        });
        return cost;
    }

    private residualPair(
        rotations: Mat3[],
        focal: number,
        distortion: number,
        target: number,
        source: number,
        sx: number,
        sy: number,
        tx: number,
        ty: number,
        slot: number,
        residuals: Float64Array,
        weights: Float64Array | null,
    ): number {
        const projected = this.project(rotations, focal, distortion, target, source, sx, sy);
        if (!projected.valid) {
            residuals[slot] = 0;
            residuals[slot + 1] = 0;
            if (weights) {
                weights[slot] = 0;
                weights[slot + 1] = 0;
            }
            return 4 * HUBER_SIGMA * HUBER_SIGMA;
        }
        const { nx, ny } = projected;
        const factor = 1 + distortion * (nx * nx + ny * ny);
        const ex = this.cx + focal * factor * nx - tx;
        const ey = this.cy + focal * factor * ny - ty;
        residuals[slot] = ex;
        residuals[slot + 1] = ey;
        const distance = Math.hypot(ex, ey);
        if (weights) {
            const weight = distance <= HUBER_SIGMA ? 1 : HUBER_SIGMA / distance;
            weights[slot] = weight;
            weights[slot + 1] = weight;
        }
        return distance <= HUBER_SIGMA
            ? distance * distance
            : 2 * HUBER_SIGMA * distance - HUBER_SIGMA * HUBER_SIGMA;
    }

    private project(
        rotations: Mat3[],
        focal: number,
        distortion: number,
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
        undistort((sx - this.cx) / focal, (sy - this.cy) / focal, distortion, this.lens);
        const wx = this.lens[0];
        const wy = this.lens[1];
        const vx = m[0] * wx + m[1] * wy + m[2];
        const vy = m[3] * wx + m[4] * wy + m[5];
        const vz = m[6] * wx + m[7] * wy + m[8];
        out.wx = wx;
        out.wy = wy;
        out.vx = vx;
        out.vy = vy;
        out.vz = vz;
        out.valid = vz > 1e-6;
        out.nx = out.valid ? vx / vz : 0;
        out.ny = out.valid ? vy / vz : 0;
        return out;
    }

    private buildJacobian(rotations: Mat3[]): void {
        this.jacobian.fill(0);
        this.observations.forEach((observation, index) => {
            const base = index * 4;
            this.jacobianPair(
                rotations,
                observation.cameraA,
                observation.cameraB,
                observation.bx,
                observation.by,
                base,
            );
            this.jacobianPair(
                rotations,
                observation.cameraB,
                observation.cameraA,
                observation.ax,
                observation.ay,
                base + 2,
            );
        });
        if (this.focalParam >= 0) {
            const step = Math.max(0.05, this.focal * 1e-5);
            this.evaluate(rotations, this.focal + step, this.distortion, this.probePlus, null);
            this.evaluate(rotations, this.focal - step, this.distortion, this.probeMinus, null);
            this.writeNumericColumn(this.focalParam, step);
        }
        if (this.distortionParam >= 0) {
            const step = 1e-5;
            this.evaluate(rotations, this.focal, this.distortion + step, this.probePlus, null);
            this.evaluate(rotations, this.focal, this.distortion - step, this.probeMinus, null);
            this.writeNumericColumn(this.distortionParam, step);
        }
    }

    private writeNumericColumn(param: number, step: number): void {
        for (let r = 0; r < this.residuals.length; r++) {
            this.jacobian[r * this.paramCount + param] =
                (this.probePlus[r] - this.probeMinus[r]) / (2 * step);
        }
    }

    private jacobianPair(
        rotations: Mat3[],
        target: number,
        source: number,
        sx: number,
        sy: number,
        slot: number,
    ): void {
        const focal = this.focal;
        const kappa = this.distortion;
        const projected = this.project(rotations, focal, kappa, target, source, sx, sy);
        if (!projected.valid) return;
        const { nx, ny, vx, vy, vz, wx, wy } = projected;
        const factor = 1 + kappa * (nx * nx + ny * ny);
        const lxx = focal * (factor + 2 * kappa * nx * nx);
        const lxy = focal * (2 * kappa * nx * ny);
        const lyy = focal * (factor + 2 * kappa * ny * ny);
        const invZ = 1 / vz;
        const rowX = slot * this.paramCount;
        const rowY = (slot + 1) * this.paramCount;
        const write = (param: number, dx: number, dy: number, dz: number): void => {
            const dnx = (dx - nx * dz) * invZ;
            const dny = (dy - ny * dz) * invZ;
            this.jacobian[rowX + param] = lxx * dnx + lxy * dny;
            this.jacobian[rowY + param] = lxy * dnx + lyy * dny;
        };
        const targetSlot = this.freeSlot[target];
        if (targetSlot >= 0) {
            for (let axis = 0; axis < 3; axis++) {
                cross(vx, vy, vz, axis, this.scratch);
                write(targetSlot + axis, this.scratch[0], this.scratch[1], this.scratch[2]);
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
                write(
                    sourceSlot + axis,
                    -(m[0] * ex + m[1] * ey + m[2] * ez),
                    -(m[3] * ex + m[4] * ey + m[5] * ez),
                    -(m[6] * ex + m[7] * ey + m[8] * ez),
                );
            }
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
