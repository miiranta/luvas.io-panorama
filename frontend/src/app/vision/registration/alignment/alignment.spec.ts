import {
    Mat3,
    mat3Identity,
    mat3Inverse,
    mat3Multiply,
    mat3Transpose,
} from '../../foundation/math/matrix3';
import { rotationAngleBetween, rotationFromAxisAngle } from '../../foundation/math/rotation';
import { BundleAdjuster, BundleObservation } from './bundle-adjuster';
import { undistort } from './lens-distortion';
import { levelHorizon } from './level-horizon';
import { GraphEdge, PoseGraph, brownLoweVerified } from './pose-graph';
import { focalFromHomography, relativeRotationFromHomography } from './rotational-camera';

const FOCAL = 700;
const CX = 319.5;
const CY = 239.5;
const degrees = (value: number) => (value * Math.PI) / 180;

function homography(rotation: Mat3): Mat3 {
    const k = new Float64Array([FOCAL, 0, CX, 0, FOCAL, CY, 0, 0, 1]);
    return mat3Multiply(k, mat3Multiply(rotation, mat3Inverse(k) as Mat3));
}

function edge(a: number, b: number, inliers: number): GraphEdge {
    return { a, b, matches: inliers * 1.5, inliers, meanError: 1, verified: true, inTree: false };
}

describe('camera alignment', () => {
    it('recovers the focal length and rotation of a rotating camera', () => {
        const rotation = mat3Multiply(
            rotationFromAxisAngle(degrees(3), 0, 0),
            rotationFromAxisAngle(0, degrees(15), 0),
        );
        const h = homography(rotation);
        expect(focalFromHomography(h, CX, CY)).toBeCloseTo(FOCAL, 3);
        expect(
            rotationAngleBetween(relativeRotationFromHomography(h, FOCAL, CX, CY), rotation),
        ).toBeLessThan(1e-9);
    });

    it('undistorts the radial model exactly', () => {
        const kappa = -0.18;
        const [nx, ny] = [0.4, -0.3];
        const factor = 1 + kappa * (nx * nx + ny * ny);
        const out = new Float64Array(2);
        undistort(nx * factor, ny * factor, kappa, out);
        expect(out[0]).toBeCloseTo(nx, 10);
        expect(out[1]).toBeCloseTo(ny, 10);
    });

    it('applies the Brown–Lowe verification rule', () => {
        expect(brownLoweVerified(30, 100)).toBe(true);
        expect(brownLoweVerified(20, 100)).toBe(false);
    });

    it('builds a spanning tree and picks the reference inside the main component', () => {
        const graph = new PoseGraph(5, [
            edge(0, 1, 60),
            edge(1, 2, 70),
            edge(0, 2, 50),
            edge(3, 4, 300),
        ]);
        expect(graph.componentCount).toBe(2);
        expect(graph.inMainComponent(graph.reference)).toBe(true);
        expect(graph.tree.filter((e) => e.a < 3).length).toBe(2);
        expect(graph.strongestPlacedNeighbor(2, new Set([1]))).toBe(1);
    });

    it('levels a horizontal sweep to the cameras’ common horizon', () => {
        const tilt = rotationFromAxisAngle(0, 0, degrees(4));
        const cameras = [0, 20, 40, 60].map((yaw) =>
            mat3Multiply(rotationFromAxisAngle(0, degrees(yaw), 0), tilt),
        );
        const orientation = levelHorizon(cameras);
        const up = [orientation[1], orientation[4], orientation[7]];
        for (const camera of cameras) {
            expect(camera[0] * up[0] + camera[1] * up[1] + camera[2] * up[2]).toBeCloseTo(0, 9);
        }
    });

    it('returns the identity horizon for fewer than three cameras', () => {
        expect(Array.from(levelHorizon([mat3Identity(), mat3Identity()]))).toEqual(
            Array.from(mat3Identity()),
        );
    });

    it('recovers perturbed rotations, focal and lens distortion by bundle adjustment', () => {
        const truth = [0, 10, 20].map((yaw) => rotationFromAxisAngle(0, degrees(yaw), 0));
        const kappa = -0.08;
        const observations: BundleObservation[] = [];
        const project = (
            target: Mat3,
            source: Mat3,
            x: number,
            y: number,
        ): [number, number] | null => {
            const lens = new Float64Array(2);
            undistort((x - CX) / FOCAL, (y - CY) / FOCAL, kappa, lens);
            const m = mat3Multiply(target, mat3Transpose(source));
            const vz = m[6] * lens[0] + m[7] * lens[1] + m[8];
            const nx = (m[0] * lens[0] + m[1] * lens[1] + m[2]) / vz;
            const ny = (m[3] * lens[0] + m[4] * lens[1] + m[5]) / vz;
            const g = 1 + kappa * (nx * nx + ny * ny);
            const px = CX + FOCAL * g * nx;
            const py = CY + FOCAL * g * ny;
            return px < 0 || py < 0 || px > 639 || py > 479 ? null : [px, py];
        };
        for (const [a, b] of [
            [0, 1],
            [1, 2],
            [0, 2],
        ]) {
            for (let i = 0; i < 80; i++) {
                const ax = 20 + ((i * 53) % 600);
                const ay = 20 + ((i * 29) % 440);
                const target = project(truth[b], truth[a], ax, ay);
                if (target)
                    observations.push({
                        cameraA: a,
                        cameraB: b,
                        ax,
                        ay,
                        bx: target[0],
                        by: target[1],
                    });
            }
        }
        const start = truth.map((r, i) =>
            i === 0 ? r : mat3Multiply(rotationFromAxisAngle(0.01, -0.008, 0.006), r),
        );
        const result = new BundleAdjuster().solve({
            rotations: start,
            focal: FOCAL * 1.04,
            distortion: 0,
            cx: CX,
            cy: CY,
            observations,
            freeCameras: [1, 2],
            refineFocal: true,
            refineDistortion: true,
            iterations: 40,
        });
        expect(result.finalError).toBeLessThan(1e-3);
        expect(result.focal).toBeCloseTo(FOCAL, 1);
        expect(result.distortion).toBeCloseTo(kappa, 4);
        for (let i = 1; i < 3; i++)
            expect(rotationAngleBetween(result.rotations[i], truth[i])).toBeLessThan(1e-5);
    });
});
