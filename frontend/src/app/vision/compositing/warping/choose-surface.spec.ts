import { mat3Identity } from '../../foundation/math/matrix3';
import { rotationFromAxisAngle } from '../../foundation/math/rotation';
import { chooseSurface } from './choose-surface';

const degrees = (value: number) => (value * Math.PI) / 180;

function photos(yaws: number[], pitches: number[] = yaws.map(() => 0)) {
    return yaws.map((yaw, i) => ({
        rotation: rotationFromAxisAngle(degrees(pitches[i]), degrees(yaw), 0),
        width: 640,
        height: 480,
        focal: 780,
        distortion: 0,
    }));
}

describe('chooseSurface', () => {
    it('keeps the plane for a narrow panorama', () => {
        expect(chooseSurface(photos([0, 15, 30]), mat3Identity())).toBe('planar');
    });

    it('switches to the cylinder for a wide horizontal sweep', () => {
        expect(chooseSurface(photos([0, 40, 80, 120, 160]), mat3Identity())).toBe('cylindrical');
    });

    it('switches to the sphere when the photos cover too much height', () => {
        expect(chooseSurface(photos([0, 0, 0, 0], [-60, -20, 20, 60]), mat3Identity())).toBe(
            'spherical',
        );
    });

    it('uses the plane before any photo exists', () => {
        expect(chooseSurface([], mat3Identity())).toBe('planar');
    });
});
