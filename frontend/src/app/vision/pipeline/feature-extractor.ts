import { PipelineParams } from '../../core/models/params';
import { BriefDescriptor } from '../features/description/brief-descriptor';
import { CornerDetector } from '../features/detection/corner-detector';
import { Keypoint } from '../features/detection/keypoint';
import { grayPyramid } from '../foundation/imaging/gray-pyramid';
import { ColorImage, toGray } from '../foundation/imaging/image';
import { DESCRIPTOR_WORDS } from '../features/description/brief-descriptor';

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

    extract(image: ColorImage, maxKeypoints?: number, scaleLevels?: number): ExtractedFeatures {
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
        const levels = grayPyramid(
            gray,
            Math.max(1, Math.round(scaleLevels ?? detectParams.scaleLevels)),
            detectParams.scaleFactor,
        );
        const quotas = this.quotas(
            levels.length,
            detectParams.maxKeypoints,
            detectParams.scaleFactor,
        );
        const detector = this.detector();
        const perLevel = levels.map((level, index) =>
            detector.detect(level.image, { ...detectParams, maxKeypoints: quotas[index] }, border),
        );
        const detected = performance.now();
        const brief = new BriefDescriptor(params.match.descriptorPatch);
        const keypoints: Keypoint[] = [];
        const described = perLevel.map((points, index) =>
            brief.describe(levels[index].image, points),
        );
        const total = perLevel.reduce((sum, points) => sum + points.length, 0);
        const descriptors = new Uint32Array(total * DESCRIPTOR_WORDS);
        let offset = 0;
        perLevel.forEach((points, index) => {
            const { scaleX, scaleY } = levels[index];
            for (const point of points) {
                keypoints.push({
                    ...point,
                    x: (point.x + 0.5) * scaleX - 0.5,
                    y: (point.y + 0.5) * scaleY - 0.5,
                    scale: Math.sqrt(scaleX * scaleY),
                });
            }
            descriptors.set(described[index], offset * DESCRIPTOR_WORDS);
            offset += points.length;
        });
        return {
            keypoints,
            descriptors,
            detectMs: detected - started,
            describeMs: performance.now() - detected,
        };
    }

    private quotas(levels: number, total: number, factor: number): number[] {
        const shrink = 1 / (factor * factor);
        const weights = Array.from({ length: levels }, (_, level) => Math.pow(shrink, level));
        const sum = weights.reduce((a, b) => a + b, 0);
        const quotas = weights.map((weight) => Math.floor((total * weight) / sum));
        quotas[0] += total - quotas.reduce((a, b) => a + b, 0);
        return quotas;
    }
}
