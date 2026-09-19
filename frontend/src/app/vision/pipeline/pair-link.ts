import { BundleObservation } from '../registration/alignment/bundle-adjuster';
import { Rgb } from '../foundation/imaging/image';
import { Mat3 } from '../foundation/math/matrix3';

export interface IntensitySample {
    ax: number;
    ay: number;
    colorA: Rgb;
    bx: number;
    by: number;
    colorB: Rgb;
}

export interface PairLink {
    a: number;
    b: number;
    matches: number;
    inliers: number;
    meanError: number;
    verified: boolean;
    focal: number | null;
    matrix: Mat3;
    observations: BundleObservation[];
    overlapPixels: number;
    intensities: IntensitySample[];
}
