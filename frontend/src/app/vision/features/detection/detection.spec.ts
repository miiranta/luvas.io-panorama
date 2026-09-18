import { DEFAULT_PARAMS } from '../../../core/models/params';
import { adaptiveSuppression } from './adaptive-suppression';
import { FAST_OFFSETS, fastSegmentTest } from './fast-segment-test';
import { harrisResponse } from './harris';
import { Keypoint } from './keypoint';
import { nonMaximumSuppression } from './non-maximum-suppression';
import { shiTomasiResponse } from './shi-tomasi';
import { refineSubPixel } from './sub-pixel-refinement';

function fastPatch(bright: number): {
    image: { width: number; height: number; data: Float32Array };
} {
    const side = 9;
    const data = new Float32Array(side * side).fill(100);
    for (const [dx, dy] of FAST_OFFSETS.slice(1, 1 + bright)) data[(4 + dy) * side + 4 + dx] = 200;
    return { image: { width: side, height: side, data } };
}

describe('corner detection', () => {
    it('scores Harris with det − α·trace²', () => {
        expect(harrisResponse(4, 1, 3, 0.05)).toBeCloseTo(11 - 0.05 * 49, 12);
    });

    it('scores Shi-Tomasi with the smallest eigenvalue', () => {
        expect(shiTomasiResponse(5, 0, 2)).toBeCloseTo(2, 12);
    });

    it('accepts a FAST arc of exactly the configured length', () => {
        const { image } = fastPatch(9);
        const response = fastSegmentTest(
            image,
            { ...DEFAULT_PARAMS.detect, fastArc: 9 },
            new Float32Array(81).fill(1),
        );
        expect(response[4 * 9 + 4]).toBeGreaterThan(0);
    });

    it('rejects a FAST arc one pixel shorter than configured', () => {
        const { image } = fastPatch(8);
        const response = fastSegmentTest(
            image,
            { ...DEFAULT_PARAMS.detect, fastArc: 9 },
            new Float32Array(81).fill(1),
        );
        expect(response[4 * 9 + 4]).toBe(0);
    });

    it('keeps only local maxima above the threshold', () => {
        const width = 20;
        const response = new Float32Array(width * width);
        response[5 * width + 5] = 10;
        response[5 * width + 7] = 8;
        response[14 * width + 14] = 9;
        response[10 * width + 10] = 0.5;
        const found = nonMaximumSuppression(response, width, width, {
            threshold: 1,
            radius: 3,
            border: 3,
            subPixel: false,
        });
        expect(found.map((k) => [k.x, k.y])).toEqual([
            [5, 5],
            [14, 14],
        ]);
    });

    it('recovers the vertex of a quadratic peak to sub-pixel accuracy', () => {
        const width = 7;
        const response = new Float32Array(width * width);
        for (let y = 0; y < width; y++) {
            for (let x = 0; x < width; x++)
                response[y * width + x] = 10 - (x - 3.3) ** 2 - 2 * (y - 2.8) ** 2;
        }
        const [x, y] = refineSubPixel(response, width, 3, 3);
        expect(x).toBeCloseTo(3.3, 5);
        expect(y).toBeCloseTo(2.8, 5);
    });

    it('spreads keypoints and respects the limit with adaptive suppression', () => {
        const points: Keypoint[] = [];
        for (let i = 0; i < 400; i++) {
            points.push({
                x: (i * 37) % 200,
                y: (i * 91) % 150,
                response: 400 - i,
                orientation: 0,
                scale: 1,
            });
        }
        const kept = adaptiveSuppression(points, 50, 200, 150);
        expect(kept.length).toBeLessThanOrEqual(50);
        expect(kept.length).toBeGreaterThanOrEqual(45);
        let closest = Infinity;
        for (let a = 0; a < kept.length; a++) {
            for (let b = a + 1; b < kept.length; b++) {
                closest = Math.min(
                    closest,
                    Math.hypot(kept[a].x - kept[b].x, kept[a].y - kept[b].y),
                );
            }
        }
        expect(closest).toBeGreaterThan(10);
    });
});
