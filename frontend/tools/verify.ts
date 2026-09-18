import { DEFAULT_PARAMS, PipelineParams } from '../src/app/core/models/params';
import { StitchPipeline } from '../src/app/vision/pipeline/stitch-pipeline';
import { Mat3, mat3Multiply, mat3Transpose } from '../src/app/vision/math/matrix3';
import { rotationFromAxisAngle } from '../src/app/vision/math/so3';
import {
    focalFromHomography,
    relativeRotationFromHomography,
} from '../src/app/vision/geometry/rotational-camera';
import { buildWorld, deg, paintMovingObject, renderView, scaleImage } from './scene';

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
    options: { moving?: boolean; intruder?: boolean } = {},
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
        const view = renderView(world, rotation, focalTruth, viewWidth, viewHeight);
        if (options.moving && i >= 1) {
            paintMovingObject(view, 180 + i * 90, 240, 26);
        }
        const work = scaleImage(view, params.detect.workWidth);
        const compose = scaleImage(view, params.compose.composeWidth);
        const { report } = await pipeline.addFrame(`#${i + 1}`, work, compose);
        reports.push(report);
        console.log(
            `  quadro ${report.label}: kp=${report.keypoints} ` +
                `inliers=${report.pairs.map((p) => p.inliers).join('/') || '-'} ` +
                `f=${report.focal.toFixed(0)} yaw=${report.yaw.toFixed(1)}° ` +
                `bundle=${report.bundleBefore.toFixed(2)}→${report.bundleAfter.toFixed(2)} ` +
                `${report.accepted ? 'ok' : 'REJEITADO: ' + report.reason}`,
        );
    }

    if (options.intruder) {
        const rotation = rotationFromAxisAngle(0, deg(180), 0);
        const view = renderView(other, rotation, focalTruth, viewWidth, viewHeight);
        const work = scaleImage(view, params.detect.workWidth);
        const compose = scaleImage(view, params.compose.composeWidth);
        const { report } = await pipeline.addFrame('intrusa', work, compose);
        check(
            `${title}: imagem intrusa rejeitada`,
            !report.accepted,
            report.accepted
                ? 'foi aceita indevidamente'
                : `rejeitada (${report.pairs.map((p) => p.inliers).join('/') || '0'} inliers)`,
        );
    }

    const accepted = reports.filter((r) => r.accepted);
    check(
        `${title}: todos os quadros integrados`,
        accepted.length === yaws.length,
        `${accepted.length}/${yaws.length} aceitos`,
    );

    const focalError =
        Math.abs(
            reports[reports.length - 1].focal - focalTruth * (params.detect.workWidth / viewWidth),
        ) /
        (focalTruth * (params.detect.workWidth / viewWidth));
    check(
        `${title}: focal estimada`,
        focalError < 0.08,
        `${reports[reports.length - 1].focal.toFixed(1)} px vs ${(focalTruth * (params.detect.workWidth / viewWidth)).toFixed(1)} px esperado (erro ${(focalError * 100).toFixed(1)}%)`,
    );

    const graph = pipeline.graph();
    const mosaic = pipeline.mosaicPayload();
    check(
        `${title}: mosaico com cobertura`,
        mosaic !== null && mosaic.spanHorizontal > 5,
        mosaic
            ? `${mosaic.spanHorizontal.toFixed(1)}°×${mosaic.spanVertical.toFixed(1)}°, ` +
                  `${mosaic.width}×${mosaic.height}, ${mosaic.fillPercent.toFixed(1)}% preenchido`
            : 'sem mosaico',
    );
    check(
        `${title}: grafo conexo`,
        graph.components === 1 || (options.intruder === true && graph.components === 2),
        `${graph.components} componente(s), ordem inferida ${graph.order.join('→')}`,
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
        `${title}: yaw recuperado`,
        worstYaw < 1.5,
        `pior desvio ${worstYaw.toFixed(2)}° (ground truth ${yaws.join('/')})`,
    );

    if (options.moving) {
        const ghosts = reports
            .filter((r) => r.accepted && r.overlapPixels > 0)
            .map((r) => (r.inconsistentPixels / r.overlapPixels) * 100);
        check(
            `${title}: pixels inconsistentes detectados`,
            ghosts.some((g) => g > 0.05),
            `máx ${Math.max(0, ...ghosts).toFixed(2)}% da sobreposição marcada como objeto móvel`,
        );
    }
}

function runUnitChecks(): void {
    console.log('\n=== unidades ===');
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
        'focal a partir da homografia',
        estimated !== null && Math.abs(estimated - focal) / focal < 0.02,
        `${estimated?.toFixed(1)} px vs ${focal} px`,
    );
    const recovered = relativeRotationFromHomography(h, focal, 320, 240);
    check(
        'rotação a partir da homografia',
        angleBetween(recovered, rotation) < 0.2,
        `desvio ${angleBetween(recovered, rotation).toFixed(3)}°`,
    );
}

const fast: PipelineParams = structuredClone(DEFAULT_PARAMS);
fast.compose.canvasWidth = 1024;
fast.compose.composeWidth = 480;
fast.detect.workWidth = 480;

runUnitChecks();
await runScenario(
    'sequência horizontal',
    structuredClone(fast),
    [0, 12, 24, 36, 48, 60],
    [0, 0, 0, 0, 0, 0],
    {
        intruder: true,
    },
);
await runScenario(
    'grade 2 fileiras',
    structuredClone(fast),
    [0, 14, 28, 28, 14, 0],
    [0, 0, 0, 12, 12, 12],
    { moving: true },
);

const cylindrical = structuredClone(fast);
cylindrical.compose.surface = 'cylindrical';
cylindrical.compose.blend = 'feather';
await runScenario('cilíndrica + feather', cylindrical, [0, 15, 30, 45], [0, 0, 0, 0]);

const planar = structuredClone(fast);
planar.compose.surface = 'planar';
planar.compose.blend = 'average';
planar.compose.seam = false;
planar.model.model = 'affine';
await runScenario('planar + afim + média', planar, [0, 8, 16], [0, 0, 0]);

async function runScalingCheck(): Promise<void> {
    console.log('\n=== custo por quadro com N crescente ===');
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
                    `[detectar ${sample.detect.toFixed(0)} casar ${sample.match.toFixed(0)} ` +
                    `bundle ${sample.bundle.toFixed(0)} compor ${sample.compose.toFixed(0)}] ` +
                    `pares=${sample.pairs}`,
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
        'custo por quadro estável após a janela encher',
        late < early * 1.5,
        `N=${window + 2}..${window + 1 + firstHalf.length}: ${early.toFixed(0)}ms vs ` +
            `N=${window + 2 + firstHalf.length}..${count}: ${late.toFixed(0)}ms`,
    );
    const pairCounts = samples.map((s) => s.pairs);
    check(
        'pares avaliados limitados pelo índice espacial',
        Math.max(...pairCounts) <= DEFAULT_PARAMS.global.candidateNeighbours,
        `máximo de ${Math.max(...pairCounts)} pares por quadro (limite ${DEFAULT_PARAMS.global.candidateNeighbours})`,
    );
    const graph = pipeline.graph();
    const accepted = graph.nodes.filter((n) => !n.rejected).length;
    check(
        'varredura de 275° integrada',
        accepted >= count - 2,
        `${accepted}/${count} câmeras no componente principal, ` +
            `${pipeline.coveragePercent().toFixed(1)}% da caixa preenchido`,
    );
}

await runScalingCheck();

const failures = results.filter((r) => !r.pass);
console.log(
    `\n${results.length - failures.length}/${results.length} verificações passaram` +
        (failures.length > 0 ? `\nfalhas: ${failures.map((f) => f.name).join('; ')}` : ''),
);
process.exit(failures.length > 0 ? 1 : 0);
