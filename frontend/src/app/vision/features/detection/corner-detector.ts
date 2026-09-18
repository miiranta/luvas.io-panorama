import { DetectParams } from '../../../core/models/params';
import { dominantOrientation } from '../description/dominant-orientation';
import { GrayImage } from '../../foundation/imaging/image';
import { adaptiveSuppression } from './adaptive-suppression';
import { DetectBackend, cpuDetectBackend } from './detect-backend';
import { fastSegmentTest } from './fast-segment-test';
import { Keypoint } from './keypoint';
import { nonMaximumSuppression } from './non-maximum-suppression';

export class CornerDetector {
    constructor(private readonly backend: DetectBackend = cpuDetectBackend) {}

    detect(image: GrayImage, params: DetectParams, borderMargin = 8): Keypoint[] {
        const { width, height } = image;
        const maps = this.backend.maps(image, params) ?? cpuDetectBackend.maps(image, params);
        if (!maps) return [];
        const response =
            params.detector === 'fast'
                ? fastSegmentTest(image, params, maps.response)
                : maps.response;
        let peak = 0;
        for (let i = 0; i < response.length; i++) if (response[i] > peak) peak = response[i];
        const radius = Math.max(1, Math.round(params.nmsRadius));
        const candidates = nonMaximumSuppression(response, width, height, {
            threshold: peak * params.relativeThreshold,
            radius,
            border: Math.max(radius + 1, borderMargin, 4),
            subPixel: params.subPixel,
        });
        const selected = params.adaptiveNms
            ? adaptiveSuppression(candidates, params.maxKeypoints, width, height)
            : candidates.sort((a, b) => b.response - a.response).slice(0, params.maxKeypoints);
        const window = Math.max(4, Math.round(params.integrationSigma * 3));
        for (const keypoint of selected) {
            keypoint.orientation = dominantOrientation(
                maps.gradient,
                width,
                height,
                Math.round(keypoint.x),
                Math.round(keypoint.y),
                window,
            );
        }
        return selected;
    }
}
