export function paintRaster(
    context: CanvasRenderingContext2D,
    pixels: ArrayBuffer,
    width: number,
    height: number,
    x = 0,
): void {
    context.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), x, 0);
}
