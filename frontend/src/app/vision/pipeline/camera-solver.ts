import { GlobalParams } from '../../core/models/params';
import { BundleAdjuster, BundleObservation } from '../geometry/bundle-adjuster';
import { relativeRotationFromHomography } from '../geometry/rotational-camera';
import { Mat3, mat3Multiply, mat3Transpose } from '../math/matrix3';
import { Keyframe } from './keyframe';
import { LinkRegistry } from './link-registry';
import { PairLink } from './pair-link';

const DEFAULT_FOCAL_FACTOR = 1.1;
const FOCAL_MEMORY = 0.7;

export interface BundleSummary {
    before: number;
    after: number;
}

const NO_BUNDLE: BundleSummary = { before: 0, after: 0 };

export class CameraSolver {
    private focalEstimate: number | null = null;
    private readonly adjuster = new BundleAdjuster();

    constructor(private readonly params: () => GlobalParams) {}

    get focal(): number | null {
        return this.focalEstimate;
    }

    reset(): void {
        this.focalEstimate = null;
    }

    focalFor(frame: { workWidth: number; workHeight: number }): number {
        return (
            this.focalEstimate ??
            this.params().focalPixels ??
            Math.max(frame.workWidth, frame.workHeight) * DEFAULT_FOCAL_FACTOR
        );
    }

    initialise(frame: Keyframe): void {
        this.focalEstimate ??= this.focalFor(frame);
    }

    absorbFocals(links: readonly PairLink[], frame: Keyframe, blend: boolean): void {
        const focals = links
            .filter((link) => link.verified && link.focal !== null)
            .map((link) => link.focal as number)
            .sort((a, b) => a - b);
        if (this.params().autoFocal && focals.length > 0) {
            const median = focals[Math.floor(focals.length / 2)];
            this.focalEstimate =
                blend && this.focalEstimate !== null
                    ? this.focalEstimate * FOCAL_MEMORY + median * (1 - FOCAL_MEMORY)
                    : median;
        } else {
            this.initialise(frame);
        }
    }

    placeRelativeTo(frame: Keyframe, parent: Keyframe, link: PairLink): Mat3 {
        const relative = relativeRotationFromHomography(
            link.matrix,
            this.focalFor(frame),
            frame.centreX,
            frame.centreY,
        );
        return link.a === frame.id
            ? mat3Multiply(mat3Transpose(relative), parent.rotation)
            : mat3Multiply(relative, parent.rotation);
    }

    adjust(active: Keyframe[], links: LinkRegistry, freeIds: readonly number[]): BundleSummary {
        const params = this.params();
        if (active.length < 2 || params.bundleIterations === 0) return NO_BUNDLE;
        const indexOf = new Map(active.map((frame, index) => [frame.id, index]));
        const observations: BundleObservation[] = [];
        for (const link of links.verified) {
            const cameraA = indexOf.get(link.a);
            const cameraB = indexOf.get(link.b);
            if (cameraA === undefined || cameraB === undefined) continue;
            for (const o of link.observations) observations.push({ ...o, cameraA, cameraB });
        }
        const freeCameras = freeIds
            .map((id) => indexOf.get(id))
            .filter((index): index is number => index !== undefined && index !== 0);
        if (observations.length === 0 || freeCameras.length === 0) return NO_BUNDLE;
        const reference = active[0];
        const result = this.adjuster.solve({
            rotations: active.map((frame) => Float64Array.from(frame.rotation) as Mat3),
            focal: this.focalFor(reference),
            cx: reference.centreX,
            cy: reference.centreY,
            observations,
            freeCameras,
            refineFocal: params.refineFocal,
            iterations: params.bundleIterations,
        });
        active.forEach((frame, index) => {
            frame.rotation = result.rotations[index];
        });
        this.focalEstimate = result.focal;
        return {
            before: result.initialError,
            after: result.finalError,
        };
    }
}
