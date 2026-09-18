import { Keypoint } from '../detection/keypoint';
import { gaussianBlur } from '../../foundation/imaging/gaussian-blur';
import { GrayImage, sampleGrayBilinear } from '../../foundation/imaging/image';

const DESCRIPTOR_BITS = 256;
export const DESCRIPTOR_WORDS = DESCRIPTOR_BITS / 32;

const SMOOTHING_SIGMA = 1.4;
const PATTERN_SEED = 0x5eed1234;

export class BriefDescriptor {
    private static readonly patterns = new Map<number, Float32Array>();

    private readonly pattern: Float32Array;

    constructor(patch: number) {
        this.pattern = BriefDescriptor.patternFor(patch);
    }

    describe(image: GrayImage, keypoints: readonly Keypoint[]): Uint32Array {
        const pattern = this.pattern;
        const smoothed = gaussianBlur(image, SMOOTHING_SIGMA);
        const out = new Uint32Array(keypoints.length * DESCRIPTOR_WORDS);
        for (let k = 0; k < keypoints.length; k++) {
            const keypoint = keypoints[k];
            const cos = Math.cos(keypoint.orientation);
            const sin = Math.sin(keypoint.orientation);
            const base = k * DESCRIPTOR_WORDS;
            for (let bit = 0; bit < DESCRIPTOR_BITS; bit++) {
                const ax = pattern[bit * 4];
                const ay = pattern[bit * 4 + 1];
                const bx = pattern[bit * 4 + 2];
                const by = pattern[bit * 4 + 3];
                const first = sampleGrayBilinear(
                    smoothed,
                    keypoint.x + ax * cos - ay * sin,
                    keypoint.y + ax * sin + ay * cos,
                );
                const second = sampleGrayBilinear(
                    smoothed,
                    keypoint.x + bx * cos - by * sin,
                    keypoint.y + bx * sin + by * cos,
                );
                if (first < second) out[base + (bit >> 5)] |= 1 << (bit & 31);
            }
        }
        return out;
    }

    private static patternFor(patch: number): Float32Array {
        const cached = BriefDescriptor.patterns.get(patch);
        if (cached) return cached;
        const pattern = BriefDescriptor.gaussianPattern(patch);
        BriefDescriptor.patterns.set(patch, pattern);
        return pattern;
    }

    private static gaussianPattern(patch: number): Float32Array {
        const random = mulberry32(PATTERN_SEED);
        const sigma = patch / 5;
        const limit = patch / 2 - 1;
        const pattern = new Float32Array(DESCRIPTOR_BITS * 4);
        const normal = () => {
            let u = 0;
            let v = 0;
            while (u === 0) u = random();
            while (v === 0) v = random();
            return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
        };
        for (let i = 0; i < pattern.length; i++) {
            pattern[i] = Math.max(-limit, Math.min(limit, normal() * sigma));
        }
        return pattern;
    }
}

function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
