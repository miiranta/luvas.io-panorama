import { GlobalParams } from '../../core/models/params';
import { BundleAdjuster, BundleObservation } from '../registration/alignment/bundle-adjuster';
import { relativeRotationFromHomography } from '../registration/alignment/rotational-camera';
import { Mat3, mat3Multiply, mat3Transpose } from '../foundation/math/matrix3';
import { median } from '../foundation/math/median';
import { Keyframe } from './keyframe';
import { LinkRegistry } from './link-registry';
import { PairLink } from './pair-link';

const DEFAULT_FOCAL_FACTOR = 1.1;
const FOCAL_MEMORY = 0.7;
const MIN_DISTORTION_CAMERAS = 3;

export class CameraSolver {
    private focalEstimate: number | null = null;
    private distortionEstimate = 0;
    private focalRefined = false;
    private readonly adjuster = new BundleAdjuster();

    constructor(private readonly params: () => GlobalParams) {}

    get focal(): number | null {
        return this.focalEstimate;
    }

    get distortion(): number {
        return this.params().refineDistortion ? this.distortionEstimate : 0;
    }

    reset(): void {
        this.focalEstimate = null;
        this.distortionEstimate = 0;
        this.focalRefined = false;
    }

    focalFor(frame: { workWidth: number; workHeight: number }): number {
        return (
            this.focalEstimate ??
            this.params().focalPixels ??
            Math.max(frame.workWidth, frame.workHeight) * DEFAULT_FOCAL_FACTOR
        );
    }

    focalAt(frame: Keyframe, width: number): number {
        return this.focalFor(frame) * (width / frame.workWidth);
    }

    initialize(frame: Keyframe): void {
        this.focalEstimate ??= this.focalFor(frame);
    }

    blendFocals(links: readonly PairLink[], frame: Keyframe): void {
        if (this.focalRefined) return;
        const measured = this.linkFocal(links);
        if (measured === null) {
            this.initialize(frame);
            return;
        }
        this.focalEstimate =
            this.focalEstimate === null
                ? measured
                : this.focalEstimate * FOCAL_MEMORY + measured * (1 - FOCAL_MEMORY);
    }

    restartFocal(links: readonly PairLink[], frame: Keyframe): void {
        this.focalRefined = false;
        const measured = this.linkFocal(links);
        if (measured === null) this.initialize(frame);
        else this.focalEstimate = measured;
    }

    private linkFocal(links: readonly PairLink[]): number | null {
        if (!this.params().autoFocal) return null;
        return median(
            links.flatMap((link) => (link.verified && link.focal !== null ? [link.focal] : [])),
        );
    }

    placeRelativeTo(frame: Keyframe, parent: Keyframe, link: PairLink): Mat3 {
        const relative = relativeRotationFromHomography(
            link.matrix,
            this.focalFor(frame),
            frame.centerX,
            frame.centerY,
        );
        return link.a === frame.id
            ? mat3Multiply(mat3Transpose(relative), parent.rotation)
            : mat3Multiply(relative, parent.rotation);
    }

    adjust(active: Keyframe[], links: LinkRegistry, freeIds: readonly number[]): number {
        const params = this.params();
        if (active.length < 2 || params.bundleIterations === 0) return 0;
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
        if (observations.length === 0 || freeCameras.length === 0) return 0;
        const reference = active[0];
        const result = this.adjuster.solve({
            rotations: active.map((frame) => frame.rotation),
            focal: this.focalFor(reference),
            distortion: this.distortion,
            cx: reference.centerX,
            cy: reference.centerY,
            observations,
            freeCameras,
            refineFocal: params.refineFocal,
            refineDistortion: params.refineDistortion && active.length >= MIN_DISTORTION_CAMERAS,
            iterations: params.bundleIterations,
        });
        active.forEach((frame, index) => {
            frame.rotation = result.rotations[index];
        });
        this.focalEstimate = result.focal;
        if (params.refineFocal) this.focalRefined = true;
        if (params.refineDistortion) this.distortionEstimate = result.distortion;
        return result.finalError;
    }
}
