import { DetectParams } from '../../core/models/params';
import { DetectBackend, cpuDetectBackend } from '../acceleration/detect-backend';
import { GrayImage } from '../imaging/image';
import { Keypoint } from './keypoint';

const FAST_OFFSETS: readonly [number, number][] = [
    [0, -3],
    [1, -3],
    [2, -2],
    [3, -1],
    [3, 0],
    [3, 1],
    [2, 2],
    [1, 3],
    [0, 3],
    [-1, 3],
    [-2, 2],
    [-3, 1],
    [-3, 0],
    [-3, -1],
    [-2, -2],
    [-1, -3],
];

export class CornerDetector {
    constructor(private readonly backend: DetectBackend = cpuDetectBackend) {}

    detect(image: GrayImage, params: DetectParams, borderMargin = 8): Keypoint[] {
        const maps = this.backend.maps(image, params) ?? cpuDetectBackend.maps(image, params);
        if (!maps) return [];
        const response =
            params.detector === 'fast'
                ? fastSegmentTest(image, params, maps.response)
                : maps.response;
        let peak = 0;
        for (let i = 0; i < response.length; i++) if (response[i] > peak) peak = response[i];
        const candidates = this.localMaxima(image, response, peak, params, borderMargin);
        const selected = params.adaptiveNms
            ? adaptiveSuppression(candidates, params.maxKeypoints)
            : candidates.sort((a, b) => b.response - a.response).slice(0, params.maxKeypoints);
        const radius = Math.max(4, Math.round(params.integrationSigma * 3));
        for (const keypoint of selected) {
            keypoint.orientation = dominantOrientation(
                maps.gradient,
                image.width,
                image.height,
                Math.round(keypoint.x),
                Math.round(keypoint.y),
                radius,
            );
        }
        return selected;
    }

    private localMaxima(
        image: GrayImage,
        response: Float32Array,
        peak: number,
        params: DetectParams,
        borderMargin: number,
    ): Keypoint[] {
        const { width, height } = image;
        const threshold = peak * params.relativeThreshold;
        const radius = Math.max(1, Math.round(params.nmsRadius));
        const border = Math.max(radius + 1, borderMargin, 4);
        const found: Keypoint[] = [];
        for (let y = border; y < height - border; y++) {
            for (let x = border; x < width - border; x++) {
                const i = y * width + x;
                const value = response[i];
                if (value <= threshold || !isLocalMaximum(response, width, i, radius)) continue;
                const [px, py] = params.subPixel ? refineSubPixel(response, width, x, y) : [x, y];
                found.push({ x: px, y: py, response: value, orientation: 0 });
            }
        }
        return found;
    }
}

function isLocalMaximum(
    response: Float32Array,
    width: number,
    index: number,
    radius: number,
): boolean {
    const value = response[index];
    for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
            if ((dx !== 0 || dy !== 0) && response[index + dy * width + dx] > value) return false;
        }
    }
    return true;
}

function refineSubPixel(
    response: Float32Array,
    width: number,
    x: number,
    y: number,
): [number, number] {
    const i = y * width + x;
    const value = response[i];
    const dxx = response[i - 1] - 2 * value + response[i + 1];
    const dyy = response[i - width] - 2 * value + response[i + width];
    const dx = (response[i + 1] - response[i - 1]) / 2;
    const dy = (response[i + width] - response[i - width]) / 2;
    const px = Math.abs(dxx) > 1e-12 ? x - dx / dxx : x;
    const py = Math.abs(dyy) > 1e-12 ? y - dy / dyy : y;
    return [
        isFinite(px) && Math.abs(px - x) <= 1 ? px : x,
        isFinite(py) && Math.abs(py - y) <= 1 ? py : y,
    ];
}

function fastSegmentTest(
    image: GrayImage,
    params: DetectParams,
    harris: Float32Array,
): Float32Array {
    const { width, height, data } = image;
    const response = new Float32Array(width * height);
    const threshold = params.fastThreshold;
    const arc = Math.max(9, Math.min(16, Math.round(params.fastArc)));
    const ring = new Int32Array(16);
    for (let i = 0; i < 16; i++) ring[i] = FAST_OFFSETS[i][1] * width + FAST_OFFSETS[i][0];
    for (let y = 3; y < height - 3; y++) {
        for (let x = 3; x < width - 3; x++) {
            const i = y * width + x;
            const center = data[i];
            const hi = center + threshold;
            const lo = center - threshold;
            let brighter = 0;
            let darker = 0;
            for (const step of [0, 4, 8, 12]) {
                const v = data[i + ring[step]];
                if (v > hi) brighter++;
                else if (v < lo) darker++;
            }
            if (brighter < 3 && darker < 3) continue;
            let runBright = 0;
            let runDark = 0;
            let bestBright = 0;
            let bestDark = 0;
            for (let k = 0; k < 16 + arc; k++) {
                const v = data[i + ring[k % 16]];
                runBright = v > hi ? runBright + 1 : 0;
                runDark = v < lo ? runDark + 1 : 0;
                if (runBright > bestBright) bestBright = runBright;
                if (runDark > bestDark) bestDark = runDark;
            }
            if (bestBright >= arc || bestDark >= arc) response[i] = Math.max(1e-6, harris[i]);
        }
    }
    return response;
}

function dominantOrientation(
    gradient: Float32Array,
    width: number,
    height: number,
    cx: number,
    cy: number,
    radius: number,
): number {
    const bins = 36;
    const hist = new Float64Array(bins);
    const x0 = Math.max(1, cx - radius);
    const x1 = Math.min(width - 2, cx + radius);
    const y0 = Math.max(1, cy - radius);
    const y1 = Math.min(height - 2, cy + radius);
    const sigma = radius / 2 || 1;
    const denom = 2 * sigma * sigma;
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            const dx = x - cx;
            const dy = y - cy;
            const r2 = dx * dx + dy * dy;
            if (r2 > radius * radius) continue;
            const i = (y * width + x) * 4;
            const weight = gradient[i + 2] * Math.exp(-r2 / denom);
            let angle = Math.atan2(gradient[i + 1], gradient[i]);
            if (angle < 0) angle += Math.PI * 2;
            const bin = Math.min(bins - 1, Math.floor((angle / (Math.PI * 2)) * bins));
            hist[bin] += weight;
        }
    }
    let best = 0;
    for (let i = 1; i < bins; i++) if (hist[i] > hist[best]) best = i;
    const prev = hist[(best - 1 + bins) % bins];
    const next = hist[(best + 1) % bins];
    const denomP = prev - 2 * hist[best] + next;
    const offset = Math.abs(denomP) < 1e-12 ? 0 : (0.5 * (prev - next)) / denomP;
    return (((best + offset + 0.5) / bins) * Math.PI * 2) % (Math.PI * 2);
}

function adaptiveSuppression(points: Keypoint[], limit: number): Keypoint[] {
    if (points.length <= limit) return points;
    const sorted = points.slice().sort((a, b) => b.response - a.response);
    const capped = sorted.slice(0, Math.min(sorted.length, Math.max(limit * 4, 1200)));
    const robust = 0.9;
    const radii = new Float64Array(capped.length);
    radii[0] = Number.POSITIVE_INFINITY;
    for (let i = 1; i < capped.length; i++) {
        let minDist = Number.POSITIVE_INFINITY;
        for (let j = 0; j < i; j++) {
            if (capped[i].response >= robust * capped[j].response) continue;
            const dx = capped[i].x - capped[j].x;
            const dy = capped[i].y - capped[j].y;
            const d = dx * dx + dy * dy;
            if (d < minDist) minDist = d;
        }
        radii[i] = minDist;
    }
    const order = Array.from(capped.keys()).sort((a, b) => radii[b] - radii[a]);
    return order.slice(0, limit).map((i) => capped[i]);
}
