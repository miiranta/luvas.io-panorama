import { solveSymmetric } from './cholesky';
import { solveLinearSystem } from './gaussian-elimination';
import { jacobiEigen, smallestEigenvector } from './jacobi-eigen';

const system = new Float64Array([4, 1, 2, 1, 3, 0.5, 2, 0.5, 5]);
const rhs = new Float64Array([1, 2, 3]);

function residual(a: Float64Array, x: Float64Array, b: Float64Array): number {
    let worst = 0;
    for (let r = 0; r < 3; r++) {
        let sum = 0;
        for (let c = 0; c < 3; c++) sum += a[r * 3 + c] * x[c];
        worst = Math.max(worst, Math.abs(sum - b[r]));
    }
    return worst;
}

describe('linear solvers', () => {
    it('solves a system by Gaussian elimination with pivoting', () => {
        const x = solveLinearSystem(new Float64Array([0, 1, 1, 1]), new Float64Array([2, 3]), 2);
        expect(Array.from(x ?? [])).toEqual([1, 2]);
    });

    it('reports a singular system', () => {
        expect(
            solveLinearSystem(new Float64Array([1, 2, 2, 4]), new Float64Array([1, 2]), 2),
        ).toBeNull();
    });

    it('solves a symmetric positive definite system by Cholesky', () => {
        const x = solveSymmetric(system, rhs, 3);
        expect(residual(system, x as Float64Array, rhs)).toBeLessThan(1e-12);
    });

    it('falls back to elimination when the matrix is not positive definite', () => {
        const indefinite = new Float64Array([1, 2, 0, 2, 1, 0, 0, 0, 3]);
        const x = solveSymmetric(indefinite, rhs, 3);
        expect(residual(indefinite, x as Float64Array, rhs)).toBeLessThan(1e-12);
    });

    it('decomposes a symmetric matrix into eigenpairs', () => {
        const { values, vectors } = jacobiEigen(system, 3);
        for (let k = 0; k < 3; k++) {
            const v = [vectors[k], vectors[3 + k], vectors[6 + k]];
            for (let r = 0; r < 3; r++) {
                const av =
                    system[r * 3] * v[0] + system[r * 3 + 1] * v[1] + system[r * 3 + 2] * v[2];
                expect(av).toBeCloseTo(values[k] * v[r], 10);
            }
        }
    });

    it('returns the eigenvector of the smallest eigenvalue', () => {
        const v = smallestEigenvector(new Float64Array([5, 0, 0, 0, 1, 0, 0, 0, 3]), 3);
        expect(Math.abs(v[1])).toBeCloseTo(1, 12);
    });
});
