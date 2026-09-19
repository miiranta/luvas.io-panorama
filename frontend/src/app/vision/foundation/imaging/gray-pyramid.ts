import { bilinearTaps, createBilinearTaps, sampleBilinear } from './bilinear';
import { gaussianBlur } from './gaussian-blur';
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
    const taps = createBilinearTaps();
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            bilinearTaps(
                image.width,
                image.height,
                (x + 0.5) * ratioX - 0.5,
                (y + 0.5) * ratioY - 0.5,
                taps,
            );
            data[y * width + x] = sampleBilinear(image.data, taps);
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
        const image = resample(gaussianBlur(previous, sigma), width, height);
        pyramid.push({ image, scaleX: base.width / width, scaleY: base.height / height });
    }
    return pyramid;
}
