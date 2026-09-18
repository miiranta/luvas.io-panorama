import { inflateSync } from 'node:zlib';
import { DEFAULT_PARAMS, PipelineParams } from '../src/app/core/models/params';
import { StitchPipeline } from '../src/app/vision/pipeline/stitch-pipeline';
import { Mat3, mat3Multiply, mat3Transpose } from '../src/app/vision/math/matrix3';
import { rotationFromAxisAngle } from '../src/app/vision/math/so3';
import {
    focalFromHomography,
    relativeRotationFromHomography,
} from '../src/app/vision/geometry/rotational-camera';
import { buildWorld, deg, paintMovingObject, renderView, scaleImage } from './scene';
import { FeatureExtractor } from '../src/app/vision/pipeline/feature-extractor';
import { CornerDetector } from '../src/app/vision/features/corner-detector';
import { DescriptorMatcher } from '../src/app/vision/features/descriptor-matcher';
import { RansacEstimator } from '../src/app/vision/geometry/ransac';
import { mat3Identity } from '../src/app/vision/math/matrix3';

function decodePng(buffer: ArrayBuffer): { width: number; height: number; data: Uint8Array } {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    let offset = 8;
    let width = 0;
    let height = 0;
    const idat: Uint8Array[] = [];
    while (offset < bytes.length) {
        const length = view.getUint32(offset);
        const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
        const body = bytes.subarray(offset + 8, offset + 8 + length);
        if (type === 'IHDR') {
            width = view.getUint32(offset + 8);
            height = view.getUint32(offset + 12);
        } else if (type === 'IDAT') {
            idat.push(body);
        }
        offset += 12 + length;
    }
    const raw = inflateSync(Buffer.concat(idat));
    const stride = width * 4;
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        for (let i = 0; i < stride; i++) {
            const value = raw[y * (stride + 1) + 1 + i];
            const left = i >= 4 ? data[y * stride + i - 4] : 0;
            const up = y > 0 ? data[(y - 1) * stride + i] : 0;
            const upLeft = i >= 4 && y > 0 ? data[(y - 1) * stride + i - 4] : 0;
            let predictor = 0;
            if (filter === 1) predictor = left;
            else if (filter === 2) predictor = up;
            else if (filter === 3) predictor = (left + up) >> 1;
            else if (filter === 4) {
                const p = left + up - upLeft;
                const pa = Math.abs(p - left);
                const pb = Math.abs(p - up);
                const pc = Math.abs(p - upLeft);
                predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
            }
            data[y * stride + i] = (value + predictor) & 0xff;
        }
    }
    return { width, height, data };
}

function angleBetween(a: Mat3, b: Mat3): number {
    const rel = mat3Multiply(a, mat3Transpose(b));
    const trace = rel[0] + rel[4] + rel[8];
    const cos = Math.min(1, Math.max(-1, (trace - 1) / 2));
    return (Math.acos(cos) * 180) / Math.PI;
}

const results: { name: string; pass: boolean; detail: string }[] = [];

function check(name: string, pass: boolean, detail: string): void {
    results.push({ name, pass, detail });
    const mark = pass ? '[32mPASS[0m' : '[31mFAIL[0m';
    console.log(`${mark}  ${name} — ${detail}`);
}

async function runScenario(
    title: string,
    params: PipelineParams,
    yaws: number[],
    pitches: number[],
    options: {
        moving?: boolean;
        intruder?: boolean;
        distortion?: number;
        vignetting?: number;
    } = {},
): Promise<void> {
    console.log(`\n=== ${title} ===`);
    const world = buildWorld(7);
    const other = buildWorld(999);
    const focalTruth = 780;
    const viewWidth = 640;
    const viewHeight = 480;
    const pipeline = new StitchPipeline();
    pipeline.setParams(params);
    const truth: Mat3[] = [];
    const reports = [];
    for (let i = 0; i < yaws.length; i++) {
        const rotation = mat3Multiply(
            rotationFromAxisAngle(deg(pitches[i] ?? 0), 0, 0),
            rotationFromAxisAngle(0, deg(yaws[i]), 0),
        );
        truth.push(rotation);
        const view = renderView(
            world,
            rotation,
            focalTruth,
            viewWidth,
            viewHeight,
            options.distortion ?? 0,
            options.vignetting ?? 0,
        );
        if (options.moving && i >= 1) {
            paintMovingObject(view, 180 + i * 90, 240, 26);
        }
        const work = scaleImage(view, params.detect.workWidth);
        const compose = scaleImage(view, params.compose.composeWidth);
        const { report } = await pipeline.addFrame(`#${i + 1}`, work, compose);
        reports.push(report);
        console.log(
            `  frame ${report.label}: kp=${report.keypoints} ` +
                `inliers=${report.pairs.map((p) => p.inliers).join('/') || '-'} ` +
                `f=${report.focal.toFixed(0)} yaw=${report.yaw.toFixed(1)}° ` +
                `bundle=${report.bundleBefore.toFixed(2)}→${report.bundleAfter.toFixed(2)} ` +
                `${report.accepted ? 'ok' : 'REJECTED: ' + report.reason}`,
        );
    }

    if (options.intruder) {
        const rotation = rotationFromAxisAngle(0, deg(180), 0);
        const view = renderView(other, rotation, focalTruth, viewWidth, viewHeight);
        const work = scaleImage(view, params.detect.workWidth);
        const compose = scaleImage(view, params.compose.composeWidth);
        const { report } = await pipeline.addFrame('intrusa', work, compose);
        check(
            `${title}: intruder image rejected`,
            !report.accepted,
            report.accepted
                ? 'was wrongly accepted'
                : `rejeitada (${report.pairs.map((p) => p.inliers).join('/') || '0'} inliers)`,
        );
    }

    const accepted = reports.filter((r) => r.accepted);
    check(
        `${title}: all frames merged`,
        accepted.length === yaws.length,
        `${accepted.length}/${yaws.length} accepted`,
    );

    const focalError =
        Math.abs(
            reports[reports.length - 1].focal - focalTruth * (params.detect.workWidth / viewWidth),
        ) /
        (focalTruth * (params.detect.workWidth / viewWidth));
    check(
        `${title}: focal estimated`,
        focalError < 0.08,
        `${reports[reports.length - 1].focal.toFixed(1)} px vs ${(focalTruth * (params.detect.workWidth / viewWidth)).toFixed(1)} px expected (error ${(focalError * 100).toFixed(1)}%)`,
    );

    const graph = pipeline.graph();
    const mosaic = pipeline.mosaicPayload();
    check(
        `${title}: mosaic has coverage`,
        mosaic !== null && mosaic.spanHorizontal > 5,
        mosaic
            ? `${mosaic.spanHorizontal.toFixed(1)}°×${mosaic.spanVertical.toFixed(1)}°, ` +
                  `${mosaic.width}×${mosaic.height}, ${mosaic.fillPercent.toFixed(1)}% filled`
            : 'no mosaic',
    );
    check(
        `${title}: graph connected`,
        graph.components === 1 || (options.intruder === true && graph.components === 2),
        `${graph.components} component(s), inferred order ${graph.order.join('→')}`,
    );

    const pairErrors: number[] = [];
    const baseNode = graph.nodes.find((n) => n.label === '#1');
    for (let i = 1; i < yaws.length; i++) {
        const nodeI = graph.nodes.find((n) => n.label === `#${i + 1}`);
        if (!nodeI || !baseNode || nodeI.rejected) continue;
        const recovered = Math.abs(nodeI.yaw - baseNode.yaw);
        pairErrors.push(Math.abs(recovered - Math.abs(yaws[i] - yaws[0])));
    }
    void truth;
    const worstYaw = pairErrors.length > 0 ? Math.max(...pairErrors) : Number.POSITIVE_INFINITY;
    check(
        `${title}: yaw recovered`,
        worstYaw < 1.5,
        `worst offset ${worstYaw.toFixed(2)}° (ground truth ${yaws.join('/')})`,
    );

    await pipeline.settle();
    if (options.distortion !== undefined) {
        const recovered = pipeline.mosaicPayload()?.distortion ?? Number.NaN;
        check(
            `${title}: lens distortion recovered`,
            Math.abs(recovered - options.distortion) < 0.03,
            `κ₁ ${recovered.toFixed(3)} vs ${options.distortion.toFixed(3)} rendered`,
        );
    }
    const vignetting = pipeline.mosaicPayload()?.vignetting ?? Number.NaN;
    const truthVignetting = options.vignetting ?? 0;
    check(
        `${title}: vignetting ${options.vignetting === undefined ? 'not invented' : 'recovered'}`,
        Math.abs(vignetting - truthVignetting) < (options.vignetting === undefined ? 0.1 : 0.06),
        `β ${vignetting.toFixed(3)} vs ${truthVignetting.toFixed(3)} rendered`,
    );
    const settledGraph = pipeline.graph();
    const settledErrors: number[] = [];
    const settledBase = settledGraph.nodes.find((n) => n.label === '#1');
    for (let i = 1; i < yaws.length; i++) {
        const node = settledGraph.nodes.find((n) => n.label === `#${i + 1}`);
        if (!node || !settledBase || node.rejected) continue;
        settledErrors.push(
            Math.abs(Math.abs(node.yaw - settledBase.yaw) - Math.abs(yaws[i] - yaws[0])),
        );
    }
    const settledWorst =
        settledErrors.length > 0 ? Math.max(...settledErrors) : Number.POSITIVE_INFINITY;
    check(
        `${title}: global refinement keeps the alignment`,
        settledWorst <= Math.max(worstYaw, 0.2) + 0.05,
        `worst offset ${settledWorst.toFixed(2)}° after refining (was ${worstYaw.toFixed(2)}°)`,
    );

    const exported = await pipeline.exportImage();
    const exportedPixels = exported ? (exported.width * exported.height) / 1e6 : 0;
    check(
        `${title}: export sampled above the preview canvas`,
        exported !== null && mosaic !== null && exported.width > mosaic.width,
        exported
            ? `${exported.width}×${exported.height} vs preview ${mosaic?.width}×${mosaic?.height}`
            : 'no export',
    );
    check(
        `${title}: export within the megapixel cap`,
        exported !== null && exportedPixels <= params.compose.exportMegapixels + 0.05,
        `${exportedPixels.toFixed(2)} MP (cap ${params.compose.exportMegapixels} MP)`,
    );
    if (exported && options.tiling) {
        const single = await pipeline.exportImage(1 << 20);
        const whole = decodePng((single ?? exported).png);
        const tiled = await pipeline.exportImage(256);
        const pieces = tiled ? decodePng(tiled.png) : null;
        let difference = Number.POSITIVE_INFINITY;
        let covered = 0;
        if (pieces && pieces.width === whole.width && pieces.height === whole.height) {
            let sum = 0;
            let count = 0;
            for (let i = 0; i < whole.data.length; i += 4) {
                if (whole.data[i + 3] === 0 && pieces.data[i + 3] === 0) continue;
                count++;
                for (let c = 0; c < 3; c++) sum += Math.abs(whole.data[i + c] - pieces.data[i + c]);
                if (whole.data[i + 3] === 255) covered++;
            }
            difference = count === 0 ? 0 : sum / (count * 3);
        }
        check(
            `${title}: tiled export matches a single-tile export`,
            difference < 0.75 && covered > 0,
            `mean |Δ| ${difference.toFixed(3)} levels over ${covered} px (256 px tiles vs one tile)`,
        );
    }

    if (options.moving) {
        const ghosts = reports
            .filter((r) => r.accepted && r.overlapPixels > 0)
            .map((r) => (r.inconsistentPixels / r.overlapPixels) * 100);
        check(
            `${title}: inconsistent pixels detected`,
            ghosts.some((g) => g > 0.05),
            `max ${Math.max(0, ...ghosts).toFixed(2)}% of the overlap flagged as a moving object`,
        );
    }
}

function zoomInliers(levels: number): { inliers: number; scale: number } {
    const params = structuredClone(DEFAULT_PARAMS);
    params.detect.scaleLevels = levels;
    const extractor = new FeatureExtractor(
        () => params,
        () => new CornerDetector(),
    );
    const world = buildWorld(11);
    const wide = extractor.extract(renderView(world, mat3Identity(), 700, 640, 480));
    const zoomed = extractor.extract(renderView(world, mat3Identity(), 700 * 1.6, 640, 480));
    const matches = new DescriptorMatcher().match(
        wide.descriptors,
        wide.keypoints.length,
        zoomed.descriptors,
        zoomed.keypoints.length,
        params.match,
    );
    const points = matches
        .filter((match) => match.accepted)
        .map((match) => ({
            sx: wide.keypoints[match.queryIndex].x,
            sy: wide.keypoints[match.queryIndex].y,
            dx: zoomed.keypoints[match.trainIndex].x,
            dy: zoomed.keypoints[match.trainIndex].y,
        }));
    const fit =
        points.length >= 4
            ? new RansacEstimator({ ...params.model, model: 'similarity' }).fit(points)
            : null;
    if (!fit) return { inliers: 0, scale: 0 };
    return { inliers: fit.inlierCount, scale: Math.hypot(fit.matrix[0], fit.matrix[3]) };
}

function runScaleChecks(): void {
    console.log('\n=== scale invariance ===');
    const single = zoomInliers(1);
    const multi = zoomInliers(3);
    check(
        'multi-scale detection matches a 1.6× zoom',
        multi.inliers >= 25 && Math.abs(multi.scale - 1.6) < 0.05,
        `${multi.inliers} inliers, zoom ${multi.scale.toFixed(3)} (single scale: ${single.inliers} inliers)`,
    );
    check(
        'multi-scale beats single scale under zoom',
        multi.inliers > single.inliers * 2,
        `${multi.inliers} vs ${single.inliers} inliers`,
    );
}

function runUnitChecks(): void {
    console.log('\n=== units ===');
    const focal = 900;
    const rotation = mat3Multiply(
        rotationFromAxisAngle(deg(4), 0, 0),
        rotationFromAxisAngle(0, deg(17), 0),
    );
    const k = new Float64Array([focal, 0, 320, 0, focal, 240, 0, 0, 1]) as Mat3;
    const kInv = new Float64Array([
        1 / focal,
        0,
        -320 / focal,
        0,
        1 / focal,
        -240 / focal,
        0,
        0,
        1,
    ]) as Mat3;
    const h = mat3Multiply(k, mat3Multiply(rotation, kInv));
    const estimated = focalFromHomography(h, 320, 240);
    check(
        'focal from the homography',
        estimated !== null && Math.abs(estimated - focal) / focal < 0.02,
        `${estimated?.toFixed(1)} px vs ${focal} px`,
    );
    const recovered = relativeRotationFromHomography(h, focal, 320, 240);
    check(
        'rotation from the homography',
        angleBetween(recovered, rotation) < 0.2,
        `desvio ${angleBetween(recovered, rotation).toFixed(3)}°`,
    );
}

const fast: PipelineParams = structuredClone(DEFAULT_PARAMS);
fast.compose.canvasWidth = 1024;
fast.compose.composeWidth = 480;
fast.detect.workWidth = 480;

runUnitChecks();
runScaleChecks();
await runScenario(
    'horizontal sequence',
    structuredClone(fast),
    [0, 12, 24, 36, 48, 60],
    [0, 0, 0, 0, 0, 0],
    {
        intruder: true,
    },
);
await runScenario(
    '2-row grid',
    structuredClone(fast),
    [0, 14, 28, 28, 14, 0],
    [0, 0, 0, 12, 12, 12],
    { moving: true, tiling: true },
);

await runScenario(
    'barrel lens κ₁ = -0.10',
    structuredClone(fast),
    [0, 12, 24, 36, 48, 60],
    [0, 0, 0, 0, 0, 0],
    { distortion: -0.1 },
);

await runScenario(
    'strong barrel κ₁ = -0.20',
    structuredClone(fast),
    [0, 12, 24, 36, 48, 60],
    [0, 0, 0, 0, 0, 0],
    { distortion: -0.2 },
);
await runScenario(
    'vignetted lens β = -0.25',
    structuredClone(fast),
    [0, 12, 24, 36, 48, 60],
    [0, 0, 0, 0, 0, 0],
    { vignetting: -0.25 },
);

const cylindrical = structuredClone(fast);
cylindrical.compose.surface = 'cylindrical';
cylindrical.compose.blend = 'feather';
await runScenario('cylindrical + feather', cylindrical, [0, 15, 30, 45], [0, 0, 0, 0]);

const planar = structuredClone(fast);
planar.compose.surface = 'planar';
planar.compose.blend = 'average';
planar.compose.seam = false;
planar.model.model = 'affine';
await runScenario('planar + affine + average', planar, [0, 8, 16], [0, 0, 0]);

async function runScalingCheck(): Promise<void> {
    console.log('\n=== per-frame cost as N grows ===');
    const params = structuredClone(DEFAULT_PARAMS);
    params.detect.workWidth = 480;
    params.compose.composeWidth = 480;
    params.compose.canvasWidth = 1024;
    params.compose.surface = 'spherical';
    params.global.keyframeMinAngle = 0;
    const world = buildWorld(7);
    const pipeline = new StitchPipeline();
    pipeline.setParams(params);
    const samples: {
        index: number;
        total: number;
        match: number;
        pairs: number;
        detect: number;
        bundle: number;
        compose: number;
    }[] = [];
    const count = 26;
    for (let i = 0; i < count; i++) {
        const rotation = mat3Multiply(
            rotationFromAxisAngle(deg(i % 2 === 0 ? 0 : 6), 0, 0),
            rotationFromAxisAngle(0, deg(i * 11), 0),
        );
        const view = renderView(world, rotation, 780, 640, 480);
        const work = scaleImage(view, params.detect.workWidth);
        const compose = scaleImage(view, params.compose.composeWidth);
        const { report } = await pipeline.addFrame(`#${i + 1}`, work, compose);
        samples.push({
            index: i + 1,
            total: report.timings.total,
            match: report.timings.match,
            pairs: report.pairs.length,
            detect: report.timings.detect + report.timings.describe,
            bundle: report.timings.bundle,
            compose: report.timings.compose,
        });
    }
    for (const sample of samples) {
        if (sample.index % 4 === 0 || sample.index <= 2) {
            console.log(
                `  N=${String(sample.index).padStart(2)}: total=${sample.total.toFixed(0)}ms ` +
                    `[detect ${sample.detect.toFixed(0)} match ${sample.match.toFixed(0)} ` +
                    `bundle ${sample.bundle.toFixed(0)} compose ${sample.compose.toFixed(0)}] ` +
                    `pairs=${sample.pairs}`,
            );
        }
    }
    const window = DEFAULT_PARAMS.global.bundleWindow;
    const steady = samples.slice(window + 1);
    const firstHalf = steady.slice(0, Math.floor(steady.length / 2));
    const secondHalf = steady.slice(Math.floor(steady.length / 2));
    const early = firstHalf.reduce((a, s) => a + s.total, 0) / firstHalf.length;
    const late = secondHalf.reduce((a, s) => a + s.total, 0) / secondHalf.length;
    check(
        'per-frame cost stable once the window fills',
        late < early * 1.5,
        `N=${window + 2}..${window + 1 + firstHalf.length}: ${early.toFixed(0)}ms vs ` +
            `N=${window + 2 + firstHalf.length}..${count}: ${late.toFixed(0)}ms`,
    );
    const pairCounts = samples.map((s) => s.pairs);
    check(
        'evaluated pairs bounded by the spatial index',
        Math.max(...pairCounts) <= DEFAULT_PARAMS.global.candidateNeighbours,
        `at most ${Math.max(...pairCounts)} pairs per frame (limit ${DEFAULT_PARAMS.global.candidateNeighbours})`,
    );
    const graph = pipeline.graph();
    const accepted = graph.nodes.filter((n) => !n.rejected).length;
    check(
        '275° sweep merged',
        accepted >= count - 2,
        `${accepted}/${count} cameras in the main component, ` +
            `${pipeline.coveragePercent().toFixed(1)}% of the box filled`,
    );
}

await runScalingCheck();

const failures = results.filter((r) => !r.pass);
console.log(
    `\n${results.length - failures.length}/${results.length} checks passed` +
        (failures.length > 0 ? `\nfalhas: ${failures.map((f) => f.name).join('; ')}` : ''),
);
process.exit(failures.length > 0 ? 1 : 0);
