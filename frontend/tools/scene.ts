import { Mat3, mat3Transpose } from '../src/app/vision/foundation/math/matrix3';
import { ColorImage } from '../src/app/vision/foundation/imaging/image';
import { undistort } from '../src/app/vision/registration/alignment/lens-distortion';

export function deg(value: number): number {
    return (value * Math.PI) / 180;
}

export function hash2(x: number, y: number, seed: number): number {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function cellColour(u: number, v: number, cell: number, seed: number, out: Float64Array): void {
    const cx = Math.floor(u / cell);
    const cy = Math.floor(v / cell);
    out[0] = hash2(cx, cy, seed);
    out[1] = hash2(cx, cy, seed + 101);
    out[2] = hash2(cx, cy, seed + 202);
}

export class World {
    constructor(readonly seed: number) {}

    sample(theta: number, phi: number, out: Float64Array): void {
        const u = ((theta + Math.PI) / (Math.PI * 2)) * 8192;
        const v = ((phi + Math.PI / 2) / Math.PI) * 4096;
        const layer = new Float64Array(3);
        let r = 0;
        let g = 0;
        let b = 0;
        let weight = 0;
        for (const [cell, amount] of [
            [96, 0.42],
            [34, 0.3],
            [12, 0.18],
            [4, 0.1],
        ] as const) {
            cellColour(u, v, cell, this.seed + cell, layer);
            r += layer[0] * amount;
            g += layer[1] * amount;
            b += layer[2] * amount;
            weight += amount;
        }
        const fine = hash2(Math.floor(u * 2), Math.floor(v * 2), this.seed + 7777);
        out[0] = Math.min(255, ((r / weight) * 0.85 + fine * 0.15) * 255);
        out[1] = Math.min(255, ((g / weight) * 0.85 + fine * 0.15) * 255);
        out[2] = Math.min(255, ((b / weight) * 0.85 + fine * 0.15) * 255);
    }
}

export function buildWorld(seed: number): World {
    return new World(seed);
}

export function renderView(
    world: World,
    rotation: Mat3,
    focal: number,
    width: number,
    height: number,
    distortion = 0,
    vignetting = 0,
): ColorImage {
    const data = new Uint8ClampedArray(width * height * 4);
    const rt = mat3Transpose(rotation);
    const sample = new Float64Array(3);
    const lens = new Float64Array(2);
    const cx = width / 2;
    const cy = height / 2;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            undistort((x + 0.5 - cx) / focal, (y + 0.5 - cy) / focal, distortion, lens);
            const ax = lens[0];
            const ay = lens[1];
            const norm = Math.hypot(ax, ay, 1);
            const dx = (rt[0] * ax + rt[1] * ay + rt[2]) / norm;
            const dy = (rt[3] * ax + rt[4] * ay + rt[5]) / norm;
            const dz = (rt[6] * ax + rt[7] * ay + rt[8]) / norm;
            const theta = Math.atan2(dx, dz);
            const phi = Math.asin(Math.min(1, Math.max(-1, dy)));
            world.sample(theta, phi, sample);
            const rx = (x + 0.5 - cx) / focal;
            const ry = (y + 0.5 - cy) / focal;
            const falloff = Math.max(0.05, 1 + vignetting * (rx * rx + ry * ry));
            const i = (y * width + x) * 4;
            data[i] = sample[0] * falloff;
            data[i + 1] = sample[1] * falloff;
            data[i + 2] = sample[2] * falloff;
            data[i + 3] = 255;
        }
    }
    return { width, height, data };
}

export function paintMovingObject(image: ColorImage, cx: number, cy: number, size: number): void {
    for (let y = -size; y <= size; y++) {
        for (let x = -size; x <= size; x++) {
            if (Math.abs(x) + Math.abs(y) > size * 1.3) continue;
            const px = Math.round(cx + x);
            const py = Math.round(cy + y);
            if (px < 0 || py < 0 || px >= image.width || py >= image.height) continue;
            const i = (py * image.width + px) * 4;
            image.data[i] = 250;
            image.data[i + 1] = 60;
            image.data[i + 2] = 40;
        }
    }
}

export function scaleImage(image: ColorImage, targetWidth: number): ColorImage {
    const scale = Math.min(1, targetWidth / image.width);
    const width = Math.max(32, Math.round(image.width * scale));
    const height = Math.max(32, Math.round(image.height * scale));
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        const sy = Math.min(image.height - 1, Math.round((y + 0.5) / scale - 0.5));
        for (let x = 0; x < width; x++) {
            const sx = Math.min(image.width - 1, Math.round((x + 0.5) / scale - 0.5));
            const src = (sy * image.width + sx) * 4;
            const dst = (y * width + x) * 4;
            data[dst] = image.data[src];
            data[dst + 1] = image.data[src + 1];
            data[dst + 2] = image.data[src + 2];
            data[dst + 3] = 255;
        }
    }
    return { width, height, data };
}
