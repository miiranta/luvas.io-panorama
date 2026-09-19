export interface KeypointRecord {
    x: number;
    y: number;
    response: number;
    orientation: number;
    scale: number;
}

export interface MatchRecord {
    queryIndex: number;
    trainIndex: number;
    accepted: boolean;
    inlier: boolean;
}

export interface StageTimings {
    detect: number;
    describe: number;
    match: number;
    model: number;
    bundle: number;
    compose: number;
    total: number;
}

export interface PairReport {
    inliers: number;
    inlierRatio: number;
    meanError: number;
    verified: boolean;
}

export interface FrameReport {
    id: number;
    label: string;
    accepted: boolean;
    reason: string;
    keypoints: number;
    focal: number;
    pairs: PairReport[];
    reprojectionError: number;
    overlapPixels: number;
    inconsistentPixels: number;
    coveragePercent: number;
    timings: StageTimings;
}

export interface ConnectionPayload {
    queryLabel: string;
    trainLabel: string;
    width: number;
    height: number;
    trainWidth: number;
    trainHeight: number;
    queryImage: ArrayBuffer;
    trainImage: ArrayBuffer;
    queryKeypoints: KeypointRecord[];
    trainKeypoints: KeypointRecord[];
    matches: MatchRecord[];
    report: PairReport;
}

export interface PreviewVector {
    fx: number;
    fy: number;
    tx: number;
    ty: number;
    inlier: boolean;
}

export interface PreviewPayload {
    width: number;
    height: number;
    referenceLabel: string;
    vectors: PreviewVector[];
    inliers: number;
    meanError: number;
    verified: boolean;
}

export interface GraphNodeRecord {
    id: number;
    label: string;
    keypoints: number;
    rejected: boolean;
    inMainComponent: boolean;
}

export interface GraphEdgeRecord {
    a: number;
    b: number;
    matches: number;
    inliers: number;
    meanError: number;
    verified: boolean;
    inTree: boolean;
}

export interface GraphPayload {
    nodes: GraphNodeRecord[];
    edges: GraphEdgeRecord[];
    order: number[];
    reference: number;
    components: number;
}

export interface MosaicPayload {
    width: number;
    height: number;
    storedBytes: number;
    blurBackend: string;
    matchBackend: string;
    detectBackend: string;
    warpBackend: string;
    mosaicBackend: string;
    pixels: ArrayBuffer;
    fillPercent: number;
    spanHorizontal: number;
    spanVertical: number;
    dropped: number;
    focal: number;
    distortion: number;
    vignetting: number;
    frames: number;
    surface: string;
}
