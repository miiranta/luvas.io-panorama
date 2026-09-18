import { DEFAULT_PARAMS } from '../../../core/models/params';
import { DESCRIPTOR_WORDS } from '../description/brief-descriptor';
import { dominantOrientation } from '../description/dominant-orientation';
import { DescriptorMatcher } from './descriptor-matcher';
import { hammingDistance } from './hamming-distance';

function descriptor(bits: number[]): Uint32Array {
    const words = new Uint32Array(DESCRIPTOR_WORDS);
    for (const bit of bits) words[bit >> 5] |= 1 << (bit & 31);
    return words;
}

function concat(...parts: Uint32Array[]): Uint32Array {
    const out = new Uint32Array(parts.length * DESCRIPTOR_WORDS);
    parts.forEach((part, i) => out.set(part, i * DESCRIPTOR_WORDS));
    return out;
}

describe('description and matching', () => {
    it('counts differing bits with Hamming distance', () => {
        const a = descriptor([0, 5, 40, 255]);
        const b = descriptor([0, 6, 40]);
        expect(hammingDistance(a, 0, b, 0)).toBe(3);
    });

    it('accepts a distinctive mutual match and rejects an ambiguous one', () => {
        const query = concat(descriptor([1, 2, 3]), descriptor([100, 101]));
        const train = concat(
            descriptor([1, 2, 3, 4]),
            descriptor([60, 61, 62, 63, 64, 65, 66, 67]),
            descriptor([100]),
            descriptor([101]),
        );
        const matches = new DescriptorMatcher().match(query, 2, train, 4, DEFAULT_PARAMS.match);
        expect(matches[0]).toMatchObject({ trainIndex: 0, accepted: true });
        expect(matches[1].accepted).toBe(false);
    });

    it('rejects a match that has no second neighbor to compare with', () => {
        const matches = new DescriptorMatcher().match(
            descriptor([1]),
            1,
            descriptor([1]),
            1,
            DEFAULT_PARAMS.match,
        );
        expect(matches[0].accepted).toBe(false);
    });

    it('finds the dominant gradient orientation', () => {
        const width = 21;
        const gradient = new Float32Array(width * width * 4);
        const angle = 1.1;
        for (let i = 0; i < width * width; i++) {
            gradient[i * 4] = Math.cos(angle);
            gradient[i * 4 + 1] = Math.sin(angle);
            gradient[i * 4 + 2] = 1;
        }
        expect(dominantOrientation(gradient, width, width, 10, 10, 6)).toBeCloseTo(angle, 1);
    });
});
