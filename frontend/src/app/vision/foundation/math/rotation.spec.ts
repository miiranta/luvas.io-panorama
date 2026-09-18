import { mat3Determinant, mat3Multiply, mat3Transpose } from './matrix3';
import {
    nearestRotation,
    opticalAxis,
    rotationAngleBetween,
    rotationFromAxisAngle,
    yawPitchDegrees,
} from './rotation';

const degrees = (value: number) => (value * Math.PI) / 180;

describe('rotation', () => {
    it('builds orthonormal rotations with determinant one', () => {
        const r = rotationFromAxisAngle(0.3, -0.2, 0.5);
        const product = mat3Multiply(r, mat3Transpose(r));
        for (let i = 0; i < 9; i++) expect(product[i]).toBeCloseTo(i % 4 === 0 ? 1 : 0, 12);
        expect(mat3Determinant(r)).toBeCloseTo(1, 12);
    });

    it('measures the angle between two rotations', () => {
        const a = rotationFromAxisAngle(0, degrees(10), 0);
        const b = rotationFromAxisAngle(0, degrees(35), 0);
        expect(rotationAngleBetween(a, b)).toBeCloseTo(degrees(25), 12);
    });

    it('projects a perturbed matrix back onto the nearest rotation', () => {
        const r = rotationFromAxisAngle(0.1, 0.4, -0.2);
        const noisy = Float64Array.from(r).map((value, i) => value + (i % 3) * 1e-3);
        const projected = nearestRotation(noisy);
        expect(mat3Determinant(projected)).toBeCloseTo(1, 10);
        expect(rotationAngleBetween(projected, r)).toBeLessThan(2e-3);
    });

    it('reads the optical axis from the third row', () => {
        const r = rotationFromAxisAngle(0, degrees(90), 0);
        const [x, y, z] = opticalAxis(r);
        expect([x, y, z].map((value) => Math.round(value * 1e9) / 1e9)).toEqual([-1, 0, 0]);
    });

    it('reports yaw and pitch of the optical axis in degrees', () => {
        const pitched = rotationFromAxisAngle(degrees(-20), 0, 0);
        const { yaw, pitch } = yawPitchDegrees(pitched);
        expect(yaw).toBeCloseTo(0, 9);
        expect(Math.abs(pitch)).toBeCloseTo(20, 9);
    });
});
