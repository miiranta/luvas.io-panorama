export function shiTomasiResponse(a: number, b: number, d: number): number {
    const det = a * d - b * b;
    const trace = a + d;
    return (trace - Math.sqrt(Math.max(0, trace * trace - 4 * det))) / 2;
}
