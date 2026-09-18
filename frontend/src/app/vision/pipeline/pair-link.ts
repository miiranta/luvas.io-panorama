import { BundleObservation } from '../geometry/bundle-adjuster';
import { Mat3 } from '../math/matrix3';

export interface IntensitySample {
    ax: number;
    ay: number;
    intensityA: number;
    bx: number;
    by: number;
    intensityB: number;
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
    meanIntensityA: number;
    meanIntensityB: number;
    overlapPixels: number;
    intensities: IntensitySample[];
}
