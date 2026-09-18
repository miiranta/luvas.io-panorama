import { BundleObservation } from '../geometry/bundle-adjuster';
import { Mat3 } from '../math/matrix3';

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
}
