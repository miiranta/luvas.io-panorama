import { PipelineParams } from '../../core/models/params';
import { BriefDescriptor } from '../features/brief-descriptor';
import { CornerDetector } from '../features/corner-detector';
import { Keypoint } from '../features/keypoint';
import { ColorImage, toGray } from '../imaging/image';

export interface ExtractedFeatures {
    keypoints: Keypoint[];
    descriptors: Uint32Array;
    detectMs: number;
    describeMs: number;
}

export class FeatureExtractor {
    constructor(
        private readonly params: () => PipelineParams,
        private readonly detector: () => CornerDetector,
    ) {}

    extract(image: ColorImage, maxKeypoints?: number): ExtractedFeatures {
        const params = this.params();
        const started = performance.now();
        const gray = toGray(image);
        const detectParams =
            maxKeypoints === undefined
                ? params.detect
                : {
                      ...params.detect,
                      maxKeypoints: Math.min(params.detect.maxKeypoints, maxKeypoints),
                  };
        const border = Math.ceil(params.match.descriptorPatch / 2) + 2;
        const keypoints = this.detector().detect(gray, detectParams, border);
        const detected = performance.now();
        const descriptors = new BriefDescriptor(params.match.descriptorPatch).describe(
            gray,
            keypoints,
        );
        return {
            keypoints,
            descriptors,
            detectMs: detected - started,
            describeMs: performance.now() - detected,
        };
    }
}
