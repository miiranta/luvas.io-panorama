import {
    Mat3,
    mat3Determinant,
    mat3Identity,
    mat3Inverse,
    mat3Multiply,
    mat3MultiplyTransposed,
    mat3Transpose,
} from './matrix3';

const sample = (): Mat3 => new Float64Array([2, -1, 0.5, 0.3, 4, 1, -2, 0.7, 3]);

function expectClose(actual: Mat3, expected: Mat3, digits = 12): void {
    for (let i = 0; i < 9; i++) expect(actual[i]).toBeCloseTo(expected[i], digits);
}

describe('matrix3', () => {
    it('multiplies by the identity without change', () => {
        expectClose(mat3Multiply(sample(), mat3Identity()), sample());
    });

    it('inverts a regular matrix', () => {
        const inverse = mat3Inverse(sample());
        expect(inverse).not.toBeNull();
        expectClose(mat3Multiply(sample(), inverse as Mat3), mat3Identity());
    });

    it('refuses to invert a singular matrix', () => {
        expect(mat3Inverse(new Float64Array([1, 2, 3, 2, 4, 6, 0, 1, 0]))).toBeNull();
    });

    it('computes the determinant', () => {
        expect(mat3Determinant(new Float64Array([2, 0, 0, 0, 3, 0, 0, 0, 4]))).toBe(24);
    });

    it('multiplies by a transpose exactly like the explicit product', () => {
        const a = sample();
        const b = mat3Transpose(sample());
        expect(Array.from(mat3MultiplyTransposed(a, b))).toEqual(
            Array.from(mat3Multiply(a, mat3Transpose(b))),
        );
    });

    it('writes into a provided output matrix', () => {
        const out = new Float64Array(9);
        expect(mat3MultiplyTransposed(sample(), sample(), out)).toBe(out);
    });
});
