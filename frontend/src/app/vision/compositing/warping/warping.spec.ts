import { mat3Identity } from '../../foundation/math/matrix3';
import { rotationFromAxisAngle } from '../../foundation/math/rotation';
import { PYRAMID_ALIGNMENT, alignDown, alignUp } from './canvas-box';
import { createCanvasGeometry, worldToCanvas } from './canvas-geometry';
import { canvasTransfer } from './canvas-transfer';
import { clipFootprint, computeFootprint, unionFootprints } from './footprint';

describe('warping geometry', () => {
    it('aligns boxes to the pyramid grid', () => {
        expect(alignDown(130)).toBe(128);
        expect(alignUp(130)).toBe(192);
        expect(alignUp(128)).toBe(128);
        expect(PYRAMID_ALIGNMENT).toBe(64);
    });

    it('maps the optical axis to the canvas center', () => {
        for (const surface of ['planar', 'cylindrical', 'spherical'] as const) {
            const geometry = createCanvasGeometry(surface, 1024, 500);
            const out = new Float64Array(2);
            expect(worldToCanvas(geometry, 0, 0, 1, out)).toBe(true);
            expect(out[0]).toBeCloseTo(geometry.width / 2, 9);
            expect(out[1]).toBeCloseTo(geometry.height / 2, 9);
        }
    });

    it('bounds a centered photo symmetrically', () => {
        const geometry = createCanvasGeometry('planar', 1024, 400);
        const footprint = computeFootprint(geometry, mat3Identity(), 640, 480, 400);
        expect(footprint.valid).toBe(true);
        expect(footprint.u0 + footprint.u1).toBeCloseTo(geometry.width, -1);
    });

    it('extends a spherical footprint to the pole it contains', () => {
        const geometry = createCanvasGeometry('spherical', 1024, 500);
        const footprint = computeFootprint(
            geometry,
            rotationFromAxisAngle(1.4, 0, 0),
            640,
            480,
            500,
        );
        expect(footprint.u0).toBe(0);
        expect(footprint.u1).toBe(geometry.width - 1);
        expect(footprint.v1).toBe(geometry.height - 1);
    });

    it('unions footprints across the 360° seam', () => {
        const geometry = createCanvasGeometry('cylindrical', 1024, 300);
        const left = rotationFromAxisAngle(0, Math.PI - 0.2, 0);
        const right = rotationFromAxisAngle(0, -Math.PI + 0.2, 0);
        const request = { width: 640, height: 480, focal: 300, distortion: 0 };
        const union = unionFootprints(geometry, [
            { rotation: left, ...request },
            { rotation: right, ...request },
        ]);
        expect(union).not.toBeNull();
        expect((union?.u1 ?? 0) - (union?.u0 ?? 0)).toBeLessThan(geometry.width / 2);
    });

    it('clips a footprint that wraps around the canvas', () => {
        const geometry = createCanvasGeometry('cylindrical', 1024, 300);
        const width = geometry.width;
        const clip = clipFootprint(
            geometry,
            { u0: width - 50, u1: width + 100, v0: 10, v1: 20 },
            { u0: 0, u1: 200, v0: 0, v1: 100 },
        );
        expect(clip).toEqual({ u0: 0, u1: 100, v0: 10, v1: 20 });
    });

    it('transfers canvas coordinates between resolutions of the same surface', () => {
        const high = createCanvasGeometry('planar', 2048, 800);
        const low = createCanvasGeometry('planar', 512, 200);
        const transfer = canvasTransfer(high, low);
        expect(transfer.scaleU * high.width).toBeCloseTo(low.width, 6);
        expect(transfer.offsetU).toBeCloseTo(0, 6);
    });
});
