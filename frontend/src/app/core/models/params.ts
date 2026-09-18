export type DetectorKind = 'harris' | 'shi-tomasi' | 'fast';
export type ModelKind = 'translation' | 'similarity' | 'affine' | 'homography';
export type SurfaceKind = 'planar' | 'cylindrical' | 'spherical';
export type BlendKind = 'average' | 'feather' | 'multiband';

export interface DetectParams {
    detector: DetectorKind;
    workWidth: number;
    derivativeSigma: number;
    integrationSigma: number;
    harrisAlpha: number;
    relativeThreshold: number;
    nmsRadius: number;
    maxKeypoints: number;
    adaptiveNms: boolean;
    fastThreshold: number;
    fastArc: number;
    subPixel: boolean;
}

export interface MatchParams {
    descriptorPatch: number;
    loweRatio: number;
    crossCheck: boolean;
}

export interface ModelParams {
    model: ModelKind;
    ransacThreshold: number;
    ransacConfidence: number;
    ransacMaxIterations: number;
    minInliers: number;
    minInlierRatio: number;
    refitOnInliers: boolean;
    rejectSkew: number;
}

export interface GlobalParams {
    focalPixels: number | null;
    autoFocal: boolean;
    bundleWindow: number;
    bundleIterations: number;
    refineFocal: boolean;
    candidateNeighbours: number;
    keyframeMinAngle: number;
}

export interface ComposeParams {
    surface: SurfaceKind;
    canvasWidth: number;
    blend: BlendKind;
    featherWidth: number;
    bands: number;
    seam: boolean;
    seamMegapixels: number;
    deghost: boolean;
    deghostThreshold: number;
    exposureCompensation: boolean;
    composeWidth: number;
    exportScale: number;
    exportMegapixels: number;
    crop: boolean;
    gpu: boolean;
}

export interface PipelineParams {
    detect: DetectParams;
    match: MatchParams;
    model: ModelParams;
    global: GlobalParams;
    compose: ComposeParams;
}

export const DEFAULT_PARAMS: PipelineParams = {
    detect: {
        detector: 'harris',
        workWidth: 640,
        derivativeSigma: 1,
        integrationSigma: 2,
        harrisAlpha: 0.04,
        relativeThreshold: 0.008,
        nmsRadius: 4,
        maxKeypoints: 900,
        adaptiveNms: true,
        fastThreshold: 20,
        fastArc: 12,
        subPixel: true,
    },
    match: {
        descriptorPatch: 31,
        loweRatio: 0.75,
        crossCheck: true,
    },
    model: {
        model: 'homography',
        ransacThreshold: 3,
        ransacConfidence: 0.995,
        ransacMaxIterations: 2000,
        minInliers: 18,
        minInlierRatio: 0.25,
        refitOnInliers: true,
        rejectSkew: 0.06,
    },
    global: {
        focalPixels: null,
        autoFocal: true,
        bundleWindow: 6,
        bundleIterations: 12,
        refineFocal: true,
        candidateNeighbours: 5,
        keyframeMinAngle: 3,
    },
    compose: {
        surface: 'planar',
        canvasWidth: 1792,
        blend: 'multiband',
        featherWidth: 32,
        bands: 4,
        seam: true,
        seamMegapixels: 0.2,
        deghost: true,
        deghostThreshold: 34,
        exposureCompensation: true,
        composeWidth: 1600,
        exportScale: 1,
        exportMegapixels: 8,
        crop: true,
        gpu: true,
    },
};

export type ParamGroup = keyof PipelineParams;
