import { blurGray } from './filters';
import { GrayImage } from './image';

const MIN_SIDE = 48;

export interface GrayLevel {
    image: GrayImage;
    scaleX: number;
    scaleY: number;
}

function resample(image: GrayImage, width: number, height: number): GrayImage {
    const data = new Float32Array(width * height);
    const ratioX = image.width / width;
    const ratioY = image.height / height;
    for (let y = 0; y < height; y++) {
        const fy = Math.min(image.height - 1, Math.max(0, (y + 0.5) * ratioY - 0.5));
        const y0 = Math.floor(fy);
        const y1 = Math.min(image.height - 1, y0 + 1);
        const ay = fy - y0;
        for (let x = 0; x < width; x++) {
            const fx = Math.min(image.width - 1, Math.max(0, (x + 0.5) * ratioX - 0.5));
            const x0 = Math.floor(fx);
            const x1 = Math.min(image.width - 1, x0 + 1);
            const ax = fx - x0;
            const top =
                image.data[y0 * image.width + x0] * (1 - ax) +
                image.data[y0 * image.width + x1] * ax;
            const bottom =
                image.data[y1 * image.width + x0] * (1 - ax) +
                image.data[y1 * image.width + x1] * ax;
            data[y * width + x] = top * (1 - ay) + bottom * ay;
        }
    }
    return { width, height, data };
}

export function grayPyramid(base: GrayImage, levels: number, factor: number): GrayLevel[] {
    const pyramid: GrayLevel[] = [{ image: base, scaleX: 1, scaleY: 1 }];
    const step = Math.max(1.05, factor);
    const sigma = 0.5 * Math.sqrt(step * step - 1);
    for (let level = 1; level < levels; level++) {
        const previous = pyramid[level - 1].image;
        const width = Math.round(previous.width / step);
        const height = Math.round(previous.height / step);
        if (width < MIN_SIDE || height < MIN_SIDE) break;
        const image = resample(blurGray(previous, sigma), width, height);
        pyramid.push({ image, scaleX: base.width / width, scaleY: base.height / height });
    }
    return pyramid;
}
