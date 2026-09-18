import { DEFAULT_PARAMS, ModelKind } from '../../../core/models/params';
import { Mat3 } from '../../foundation/math/matrix3';
import { Correspondence, localizationScale, localizationWeight } from './correspondence';
import { fitModel } from './fit-model';
import { hartleyNormalization } from './hartley-normalization';
import { RansacEstimator } from './ransac-estimator';
import { symmetricTransferError, transferError } from './transfer-error';

const truth: Record<ModelKind, Mat3> = {
    translation: new Float64Array([1, 0, 12, 0, 1, -7, 0, 0, 1]),
    similarity: new Float64Array([0.9, -0.2, 5, 0.2, 0.9, 3, 0, 0, 1]),
    affine: new Float64Array([1.1, 0.1, -4, -0.05, 0.95, 8, 0, 0, 1]),
    homography: new Float64Array([1.02, 0.03, 15, -0.01, 0.98, -6, 2e-4, -1e-4, 1]),
};

function apply(h: Mat3, x: number, y: number): [number, number] {
    const w = h[6] * x + h[7] * y + h[8];
    return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
}

function correspondences(h: Mat3, count: number): Correspondence[] {
    return Array.from({ length: count }, (_, i) => {
        const sx = (i * 97) % 640;
        const sy = (i * 61) % 480;
        const [dx, dy] = apply(h, sx, sy);
        return { sx, sy, dx, dy };
    });
}

function seeded(): () => number {
    let state = 7;
    return () => (state = (state * 16807) % 2147483647) / 2147483647;
}

describe('model estimation', () => {
    for (const kind of ['translation', 'similarity', 'affine', 'homography'] as ModelKind[]) {
        it(`recovers an exact ${kind}`, () => {
            const points = correspondences(truth[kind], 12);
            const fitted = fitModel(
                kind,
                points,
                points.map((_, i) => i),
            ) as Mat3;
            for (const p of points) expect(transferError(fitted, p)).toBeLessThan(1e-6);
        });
    }

    it('solves the minimal four-point homography exactly', () => {
        const points = [
            [10, 20],
            [600, 35],
            [580, 460],
            [40, 430],
        ].map(([sx, sy]) => {
            const [dx, dy] = apply(truth.homography, sx, sy);
            return { sx, sy, dx, dy };
        });
        const fitted = fitModel('homography', points, [0, 1, 2, 3]) as Mat3;
        for (const p of points) expect(transferError(fitted, p)).toBeLessThan(1e-8);
    });

    it('normalizes points to the origin with mean distance √2', () => {
        const points = correspondences(truth.affine, 20);
        const { scale, mx, my } = hartleyNormalization(
            points,
            points.map((_, i) => i),
            true,
        );
        let mean = 0;
        for (const p of points) mean += Math.hypot(scale * (p.sx - mx), scale * (p.sy - my));
        expect(mean / points.length).toBeCloseTo(Math.SQRT2, 10);
    });

    it('averages forward and backward transfer error symmetrically', () => {
        const identity = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
        const error = symmetricTransferError(identity, identity, { sx: 0, sy: 0, dx: 3, dy: 4 });
        expect(error).toBeCloseTo(5, 12);
    });

    it('scales tolerance and weight with the coarser keypoint', () => {
        const point = { sx: 0, sy: 0, dx: 0, dy: 0, sourceScale: 1.5, targetScale: 2.25 };
        expect(localizationScale(point)).toBe(2.25);
        expect(localizationWeight(point)).toBeCloseTo(1 / 2.25 ** 2, 12);
    });

    it('rejects outliers and keeps every inlier with RANSAC', () => {
        const points = correspondences(truth.homography, 60);
        for (let i = 0; i < 60; i += 4)
            points[i] = { ...points[i], dx: points[i].dx + 40, dy: points[i].dy - 25 };
        const fit = new RansacEstimator(DEFAULT_PARAMS.model, seeded()).fit(points);
        expect(fit).not.toBeNull();
        expect(fit?.inlierCount).toBe(45);
        points.forEach((_, i) => expect(fit?.inliers[i]).toBe(i % 4 === 0 ? 0 : 1));
        expect(fit?.meanError).toBeLessThan(1e-6);
    });

    it('rejects a degenerate collinear sample', () => {
        const collinear = [0, 1, 2, 3].map((i) => ({
            sx: i * 10,
            sy: i * 5,
            dx: i * 11,
            dy: i * 6,
        }));
        expect(fitModel('homography', collinear, [0, 1, 2, 3])).toBeNull();
    });

    it('needs at least the minimal sample', () => {
        expect(
            new RansacEstimator(DEFAULT_PARAMS.model).fit(correspondences(truth.homography, 3)),
        ).toBeNull();
    });
});
