export type DetectorKind = 'harris' | 'shi-tomasi' | 'fast';
export type ModelKind = 'translation' | 'similarity' | 'affine' | 'homography';
export type SurfaceKind = 'planar' | 'cylindrical' | 'spherical';
export type SurfaceChoice = SurfaceKind | 'auto';
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
    scaleLevels: number;
    scaleFactor: number;
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
    refineDistortion: boolean;
    candidateNeighbors: number;
    keyframeMinAngle: number;
}

export interface ComposeParams {
    surface: SurfaceChoice;
    canvasWidth: number;
    blend: BlendKind;
    featherWidth: number;
    bands: number;
    seam: boolean;
    seamMegapixels: number;
    deghost: boolean;
    deghostThreshold: number;
    exposureCompensation: boolean;
    blockGains: boolean;
    vignetting: boolean;
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
        scaleLevels: 3,
        scaleFactor: 1.5,
    },
    match: {
        descriptorPatch: 31,
        loweRatio: 0.75,
        crossCheck: true,
    },
    model: {
        model: 'homography',
        ransacThreshold: 2.5,
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
        refineDistortion: true,
        candidateNeighbors: 5,
        keyframeMinAngle: 3,
    },
    compose: {
        surface: 'auto',
        canvasWidth: 1792,
        blend: 'multiband',
        featherWidth: 32,
        bands: 4,
        seam: true,
        seamMegapixels: 0.2,
        deghost: true,
        deghostThreshold: 34,
        exposureCompensation: true,
        blockGains: true,
        vignetting: true,
        composeWidth: 1600,
        exportScale: 1,
        exportMegapixels: 120,
        crop: true,
        gpu: true,
    },
};

export type ParamGroup = keyof PipelineParams;

export type ParamValue = number | boolean | string;

type ParamRecord = Record<string, ParamValue>;

export function paramValue(params: PipelineParams, group: ParamGroup, key: string): ParamValue {
    return (params[group] as unknown as ParamRecord)[key];
}

export function withParam(
    params: PipelineParams,
    group: ParamGroup,
    key: string,
    value: ParamValue,
): PipelineParams {
    const next = structuredClone(params);
    (next[group] as unknown as ParamRecord)[key] = value;
    return next;
}
