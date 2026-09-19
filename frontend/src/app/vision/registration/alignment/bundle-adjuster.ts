import { Mat3, mat3Multiply, mat3MultiplyTransposed } from '../../foundation/math/matrix3';
import { nearestRotation, rotationFromAxisAngle } from '../../foundation/math/rotation';
import { solveSymmetric } from '../../foundation/math/cholesky';
import { MAX_DISTORTION, distortFactor, undistort } from './lens-distortion';

const HUBER_SIGMA = 2;
const ANGLE_PRIOR = Math.PI / 16;
const FOCAL_PRIOR_FRACTION = 0.1;
const DISTORTION_PRIOR = 0.1;
const MIN_FOCAL = 60;
const MAX_ATTEMPTS = 6;
const ROW_SLOTS = 8;
const FOCAL_SLOT = 6;
const DISTORTION_SLOT = 7;

export interface BundleObservation {
    cameraA: number;
    cameraB: number;
    ax: number;
    ay: number;
    bx: number;
    by: number;
    scaleA?: number;
    scaleB?: number;
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

function clampDistortion(value: number): number {
    return Math.min(MAX_DISTORTION, Math.max(-MAX_DISTORTION, value));
}

function forEachDirection(
    observation: BundleObservation,
    index: number,
    visit: (
        target: number,
        source: number,
        sx: number,
        sy: number,
        tx: number,
        ty: number,
        scale: number,
        slot: number,
    ) => void,
): void {
    const { cameraA, cameraB, ax, ay, bx, by } = observation;
    visit(cameraA, cameraB, bx, by, ax, ay, observation.scaleA ?? 1, index * 4);
    visit(cameraB, cameraA, ax, ay, bx, by, observation.scaleB ?? 1, index * 4 + 2);
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
    private columns = new Int32Array(0);
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
        const finish = (): BundleResult => ({
            rotations,
            focal: this.focal,
            distortion: this.distortion,
            finalError: this.rootMeanSquare(),
        });
        if (this.paramCount === 0 || residualCount < this.paramCount || iterations === 0) {
            return finish();
        }
        if (this.jacobian.length !== residualCount * ROW_SLOTS) {
            this.jacobian = new Float64Array(residualCount * ROW_SLOTS);
            this.columns = new Int32Array(residualCount * ROW_SLOTS);
        }

        let lambda = 1e-3;
        for (let iteration = 0; iteration < iterations; iteration++) {
            this.buildJacobian(rotations);
            const { normal, gradient } = this.normalEquations(residualCount);
            const prior = this.priorDiagonal();
            let improved = false;
            for (let attempt = 0; attempt < MAX_ATTEMPTS && !improved; attempt++) {
                const damped = Float64Array.from(normal);
                for (let a = 0; a < this.paramCount; a++) {
                    damped[a * this.paramCount + a] += lambda * prior[a];
                }
                const delta = solveSymmetric(damped, gradient, this.paramCount);
                if (!delta) {
                    lambda *= 10;
                    continue;
                }
                const candidate = this.rotatedBy(rotations, delta);
                const candidateFocal =
                    this.focalParam >= 0
                        ? Math.max(MIN_FOCAL, this.focal + delta[this.focalParam])
                        : this.focal;
                const candidateDistortion =
                    this.distortionParam >= 0
                        ? clampDistortion(this.distortion + delta[this.distortionParam])
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

    private normalEquations(residualCount: number): {
        normal: Float64Array;
        gradient: Float64Array;
    } {
        const size = this.paramCount;
        const normal = new Float64Array(size * size);
        const gradient = new Float64Array(size);
        for (let r = 0; r < residualCount; r++) {
            const weight = this.weights[r];
            if (weight === 0) continue;
            this.accumulateRow(r * ROW_SLOTS, weight, this.residuals[r], normal, gradient);
        }
        for (let a = 0; a < size; a++) {
            for (let b = 0; b < a; b++) normal[a * size + b] = normal[b * size + a];
        }
        return { normal, gradient };
    }

    private accumulateRow(
        base: number,
        weight: number,
        residual: number,
        normal: Float64Array,
        gradient: Float64Array,
    ): void {
        for (let a = 0; a < ROW_SLOTS; a++) {
            const column = this.columns[base + a];
            if (column < 0) continue;
            const weighted = weight * this.jacobian[base + a];
            if (weighted === 0) continue;
            gradient[column] -= weighted * residual;
            for (let b = 0; b < ROW_SLOTS; b++) {
                const other = this.columns[base + b];
                if (other < column) continue;
                normal[column * this.paramCount + other] += weighted * this.jacobian[base + b];
            }
        }
    }

    private rotatedBy(rotations: readonly Mat3[], delta: Float64Array): Mat3[] {
        return rotations.map((rotation, camera) => {
            const slot = this.freeSlot[camera];
            if (slot < 0) return Float64Array.from(rotation) as Mat3;
            const step = rotationFromAxisAngle(delta[slot], delta[slot + 1], delta[slot + 2]);
            return nearestRotation(mat3Multiply(step, rotation));
        });
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
        this.observations.forEach((observation, index) =>
            forEachDirection(observation, index, (target, source, sx, sy, tx, ty, scale, slot) => {
                cost += this.residualPair(
                    rotations,
                    focal,
                    distortion,
                    target,
                    source,
                    sx,
                    sy,
                    tx,
                    ty,
                    scale,
                    slot,
                    residuals,
                    weights,
                );
            }),
        );
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
        uncertainty: number,
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
        const factor = distortFactor(nx, ny, distortion);
        const ex = this.cx + focal * factor * nx - tx;
        const ey = this.cy + focal * factor * ny - ty;
        residuals[slot] = ex;
        residuals[slot + 1] = ey;
        const sigma = Math.max(1, uncertainty);
        const distance = Math.hypot(ex, ey) / sigma;
        if (weights) {
            const weight = (distance <= HUBER_SIGMA ? 1 : HUBER_SIGMA / distance) / (sigma * sigma);
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
        const m = mat3MultiplyTransposed(a, b, this.relative);
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
        this.columns.fill(-1);
        this.observations.forEach((observation, index) =>
            forEachDirection(observation, index, (target, source, sx, sy, _tx, _ty, _scale, slot) =>
                this.jacobianPair(rotations, target, source, sx, sy, slot),
            ),
        );
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
        const slot = param === this.focalParam ? FOCAL_SLOT : DISTORTION_SLOT;
        for (let r = 0; r < this.residuals.length; r++) {
            this.jacobian[r * ROW_SLOTS + slot] =
                (this.probePlus[r] - this.probeMinus[r]) / (2 * step);
            this.columns[r * ROW_SLOTS + slot] = param;
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
        const factor = distortFactor(nx, ny, kappa);
        const lxx = focal * (factor + 2 * kappa * nx * nx);
        const lxy = focal * (2 * kappa * nx * ny);
        const lyy = focal * (factor + 2 * kappa * ny * ny);
        const invZ = 1 / vz;
        const rowX = slot * ROW_SLOTS;
        const rowY = (slot + 1) * ROW_SLOTS;
        const write = (entry: number, param: number, dx: number, dy: number, dz: number): void => {
            const dnx = (dx - nx * dz) * invZ;
            const dny = (dy - ny * dz) * invZ;
            this.jacobian[rowX + entry] = lxx * dnx + lxy * dny;
            this.jacobian[rowY + entry] = lxy * dnx + lyy * dny;
            this.columns[rowX + entry] = param;
            this.columns[rowY + entry] = param;
        };
        const targetSlot = this.freeSlot[target];
        if (targetSlot >= 0) {
            for (let axis = 0; axis < 3; axis++) {
                cross(vx, vy, vz, axis, this.scratch);
                write(axis, targetSlot + axis, this.scratch[0], this.scratch[1], this.scratch[2]);
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
                    3 + axis,
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
