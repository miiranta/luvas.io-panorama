export function refineSubPixel(
    response: Float32Array,
    width: number,
    x: number,
    y: number,
): [number, number] {
    const i = y * width + x;
    const value = response[i];
    const dx = (response[i + 1] - response[i - 1]) / 2;
    const dy = (response[i + width] - response[i - width]) / 2;
    const dxx = response[i - 1] - 2 * value + response[i + 1];
    const dyy = response[i - width] - 2 * value + response[i + width];
    const dxy =
        (response[i + width + 1] -
            response[i + width - 1] -
            response[i - width + 1] +
            response[i - width - 1]) /
        4;
    const determinant = dxx * dyy - dxy * dxy;
    if (Math.abs(determinant) < 1e-12) return [x, y];
    const ox = -(dyy * dx - dxy * dy) / determinant;
    const oy = -(dxx * dy - dxy * dx) / determinant;
    if (!isFinite(ox) || !isFinite(oy) || Math.abs(ox) > 1 || Math.abs(oy) > 1) return [x, y];
    return [x + ox, y + oy];
}
