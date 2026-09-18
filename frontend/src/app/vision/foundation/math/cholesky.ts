import { solveLinearSystem } from './gaussian-elimination';

export function solveSymmetric(a: Float64Array, b: Float64Array, n: number): Float64Array | null {
    const lower = new Float64Array(n * n);
    for (let row = 0; row < n; row++) {
        for (let column = 0; column <= row; column++) {
            let sum = a[row * n + column];
            for (let k = 0; k < column; k++) sum -= lower[row * n + k] * lower[column * n + k];
            if (row === column) {
                if (sum <= 1e-300) return solveLinearSystem(a, b, n);
                lower[row * n + row] = Math.sqrt(sum);
            } else {
                lower[row * n + column] = sum / lower[column * n + column];
            }
        }
    }
    const y = new Float64Array(n);
    for (let row = 0; row < n; row++) {
        let sum = b[row];
        for (let k = 0; k < row; k++) sum -= lower[row * n + k] * y[k];
        y[row] = sum / lower[row * n + row];
    }
    const x = new Float64Array(n);
    for (let row = n - 1; row >= 0; row--) {
        let sum = y[row];
        for (let k = row + 1; k < n; k++) sum -= lower[k * n + row] * x[k];
        x[row] = sum / lower[row * n + row];
    }
    return x;
}
