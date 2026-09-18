const UNDISTORT_ITERATIONS = 8;

export const MAX_DISTORTION = 0.3;

export function distortFactor(nx: number, ny: number, kappa: number): number {
    return 1 + kappa * (nx * nx + ny * ny);
}

export function undistort(dx: number, dy: number, kappa: number, out: Float64Array): void {
    if (kappa === 0) {
        out[0] = dx;
        out[1] = dy;
        return;
    }
    let nx = dx;
    let ny = dy;
    for (let iteration = 0; iteration < UNDISTORT_ITERATIONS; iteration++) {
        const r2 = nx * nx + ny * ny;
        const factor = 1 + kappa * r2;
        const derivative = 1 + 3 * kappa * r2;
        const radius = Math.sqrt(r2);
        if (radius < 1e-12 || Math.abs(derivative) < 1e-9) {
            nx = dx / factor;
            ny = dy / factor;
            continue;
        }
        const target = Math.hypot(dx, dy);
        const next = radius - (radius * factor - target) / derivative;
        const scale = next / radius;
        nx *= scale;
        ny *= scale;
    }
    out[0] = nx;
    out[1] = ny;
}
