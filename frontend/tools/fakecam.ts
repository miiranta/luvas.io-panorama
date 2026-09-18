import { writeFileSync } from 'node:fs';
import { mat3Multiply } from '../src/app/vision/math/matrix3';
import { rotationFromAxisAngle } from '../src/app/vision/math/so3';
import { buildWorld, deg, paintMovingObject, renderView } from './scene';

const width = 640;
const height = 480;
const frames = 120;
const sweep = 72;
const focal = 620;

const world = buildWorld(7);
const header = `YUV4MPEG2 W${width} H${height} F10:1 Ip A1:1 C420mpeg2\n`;
const frameSize = width * height + 2 * ((width / 2) * (height / 2));
const chunks: Buffer[] = [Buffer.from(header, 'ascii')];

for (let f = 0; f < frames; f++) {
    const t = f / (frames - 1);
    const yaw = t * sweep;
    const pitch = Math.sin(t * Math.PI * 2) * 1.5;
    const rotation = mat3Multiply(
        rotationFromAxisAngle(deg(pitch), 0, 0),
        rotationFromAxisAngle(0, deg(yaw), 0),
    );
    const view = renderView(world, rotation, focal, width, height);
    if (f > frames * 0.4) {
        paintMovingObject(view, 120 + ((f - frames * 0.4) / frames) * 900, 300, 30);
    }
    const buffer = Buffer.alloc(frameSize + 6);
    buffer.write('FRAME\n', 0, 'ascii');
    let offset = 6;
    const halfWidth = width / 2;
    const halfHeight = height / 2;
    const u = new Uint8Array(halfWidth * halfHeight);
    const v = new Uint8Array(halfWidth * halfHeight);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            const r = view.data[i];
            const g = view.data[i + 1];
            const b = view.data[i + 2];
            buffer[offset + y * width + x] = Math.max(
                0,
                Math.min(255, 0.257 * r + 0.504 * g + 0.098 * b + 16),
            );
            if (y % 2 === 0 && x % 2 === 0) {
                const index = (y / 2) * halfWidth + x / 2;
                u[index] = Math.max(0, Math.min(255, -0.148 * r - 0.291 * g + 0.439 * b + 128));
                v[index] = Math.max(0, Math.min(255, 0.439 * r - 0.368 * g - 0.071 * b + 128));
            }
        }
    }
    offset += width * height;
    buffer.set(u, offset);
    offset += u.length;
    buffer.set(v, offset);
    chunks.push(buffer);
}

const target = process.argv[2] ?? '/tmp/pano.y4m';
writeFileSync(target, Buffer.concat(chunks));
console.log(`wrote ${target} — ${frames} frames ${width}x${height}, ${sweep}° sweep`);
