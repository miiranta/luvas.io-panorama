import { DEFAULT_PARAMS, GlobalParams } from '../../core/models/params';
import { mat3Identity } from '../foundation/math/matrix3';
import { CameraSolver } from './camera-solver';
import { Keyframe } from './keyframe';
import { PairLink } from './pair-link';

const frame = new Keyframe(0, '#1', 640, 480, [], new Uint32Array(0), null, null);

function link(focal: number | null, verified = true): PairLink {
    return {
        a: 0,
        b: 1,
        matches: 100,
        inliers: 60,
        meanError: 0.5,
        verified,
        focal,
        matrix: mat3Identity(),
        observations: [],
        overlapPixels: 1,
        intensities: [],
    };
}

describe('CameraSolver', () => {
    const params = (): GlobalParams => DEFAULT_PARAMS.global;

    it('starts from a default focal when nothing is measured', () => {
        const solver = new CameraSolver(params);
        solver.blendFocals([], frame);
        expect(solver.focal).toBeCloseTo(640 * 1.1, 9);
    });

    it('blends new focal measurements into the running estimate', () => {
        const solver = new CameraSolver(params);
        solver.blendFocals([link(600), link(700)], frame);
        expect(solver.focal).toBe(650);
        solver.blendFocals([link(750)], frame);
        expect(solver.focal).toBeCloseTo(650 * 0.7 + 750 * 0.3, 9);
    });

    it('ignores unverified links', () => {
        const solver = new CameraSolver(params);
        solver.blendFocals([link(600), link(9000, false)], frame);
        expect(solver.focal).toBe(600);
    });

    it('restarts from the median of all links', () => {
        const solver = new CameraSolver(params);
        solver.blendFocals([link(500)], frame);
        solver.restartFocal([link(600), link(620), link(900)], frame);
        expect(solver.focal).toBe(620);
    });

    it('places the principal point at the image center', () => {
        expect([frame.centerX, frame.centerY]).toEqual([319.5, 239.5]);
    });
});
