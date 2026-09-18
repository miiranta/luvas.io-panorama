export function harrisResponse(a: number, b: number, d: number, alpha: number): number {
    const det = a * d - b * b;
    const trace = a + d;
    return det - alpha * trace * trace;
}
