export interface BilinearTaps {
    i00: number;
    i10: number;
    i01: number;
    i11: number;
    w00: number;
    w10: number;
    w01: number;
    w11: number;
}

export function createBilinearTaps(): BilinearTaps {
    return { i00: 0, i10: 0, i01: 0, i11: 0, w00: 0, w10: 0, w01: 0, w11: 0 };
}

export function bilinearTaps(
    width: number,
    height: number,
    x: number,
    y: number,
    taps: BilinearTaps,
): BilinearTaps {
    const cx = Math.min(width - 1, Math.max(0, x));
    const cy = Math.min(height - 1, Math.max(0, y));
    const x0 = Math.floor(cx);
    const y0 = Math.floor(cy);
    const x1 = Math.min(width - 1, x0 + 1);
    const y1 = Math.min(height - 1, y0 + 1);
    const ax = cx - x0;
    const ay = cy - y0;
    taps.i00 = y0 * width + x0;
    taps.i10 = y0 * width + x1;
    taps.i01 = y1 * width + x0;
    taps.i11 = y1 * width + x1;
    taps.w00 = (1 - ax) * (1 - ay);
    taps.w10 = ax * (1 - ay);
    taps.w01 = (1 - ax) * ay;
    taps.w11 = ax * ay;
    return taps;
}

export function sampleBilinear(
    data: ArrayLike<number>,
    taps: BilinearTaps,
    channels = 1,
    channel = 0,
): number {
    return (
        data[taps.i00 * channels + channel] * taps.w00 +
        data[taps.i10 * channels + channel] * taps.w10 +
        data[taps.i01 * channels + channel] * taps.w01 +
        data[taps.i11 * channels + channel] * taps.w11
    );
}
