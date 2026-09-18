import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP_URL = process.env.APP_URL ?? 'http://localhost:4173';
const VIDEO = process.env.FAKE_VIDEO ?? '/tmp/pano.y4m';
const SHOTS = Number(process.env.SHOTS ?? 8);
const profile = mkdtempSync(join(tmpdir(), 'chrome-prof-'));
const args = [
    '--headless=new',
    '--remote-debugging-port=9334',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--window-size=1280,900',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${VIDEO}`,
    '--autoplay-policy=no-user-gesture-required',
];
if (process.env.SOFTWARE_GL === '1') {
    args.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
} else {
    args.push('--use-angle=gl', '--enable-gpu');
}
args.push('about:blank');
const chrome = spawn('google-chrome', args, { stdio: ['ignore', 'pipe', 'pipe'] });

async function endpoint() {
    for (let attempt = 0; attempt < 80; attempt++) {
        try {
            const response = await fetch('http://127.0.0.1:9334/json/version');
            return (await response.json()).webSocketDebuggerUrl;
        } catch {
            await new Promise((r) => setTimeout(r, 250));
        }
    }
    throw new Error('devtools unavailable');
}

const socket = new WebSocket(await endpoint());
await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
let nextId = 1;
const pending = new Map();
socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
    }
});
const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
    });

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const call = (m, p) => send(m, p, sessionId);
await call('Page.enable');
await call('Runtime.enable');

const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await call('Page.navigate', { url: APP_URL });
await wait(2500);
await evaluate(`document.querySelector('app-camera-stage button.start')?.click()`);
await wait(3000);

const setGpu = (gpu) =>
    evaluate(`
        (async () => {
            document.querySelector('app-camera-stage button[title="Parameters"]').click();
            await new Promise((r) => setTimeout(r, 300));
            const more = [...document.querySelectorAll('app-settings-sheet .link')].find((b) =>
                /more options/.test(b.textContent),
            );
            if (more && document.querySelectorAll('app-settings-sheet .row').length < 20) {
                more.click();
                await new Promise((r) => setTimeout(r, 300));
            }
            const target = [...document.querySelectorAll('app-settings-sheet .row')].find((row) =>
                /^GPU/.test(row.textContent.trim()),
            );
            const button = target?.querySelector('button.switch');
            if (button && button.classList.contains('on') !== ${gpu}) button.click();
            await new Promise((r) => setTimeout(r, 400));
            document.querySelector('app-settings-sheet .backdrop')?.click();
            await new Promise((r) => setTimeout(r, 300));
            return button !== null && button !== undefined;
        })()
    `);

const reset = () =>
    evaluate(`
        (async () => {
            const button = document.querySelector('app-camera-stage button.reset');
            if (button && !button.disabled) {
                button.click();
                await new Promise((r) => setTimeout(r, 300));
                document.querySelector('app-confirm-dialog .danger')?.click();
                await new Promise((r) => setTimeout(r, 800));
            }
        })()
    `);

const shoot = () =>
    evaluate(`
        (() => {
            const button = document.querySelector('app-camera-stage button.shutter');
            if (button && !button.disabled) button.click();
        })()
    `);

const readInsights = () =>
    evaluate(`
        (async () => {
            document.querySelector('app-camera-stage button[title="Metrics and graph"]').click();
            await new Promise((r) => setTimeout(r, 500));
            const stages = [...document.querySelectorAll('app-insights-sheet .bar')].map((bar) => {
                const cells = bar.querySelectorAll('span, b');
                return [cells[0].textContent.trim(), Number(cells[cells.length - 1].textContent)];
            });
            const rows = [...document.querySelectorAll('app-insights-sheet dl div')].map((row) =>
                row.textContent.replace(/\\s+/g, ' ').trim(),
            );
            const chip =
                document.querySelector('app-camera-stage .chip')?.textContent ?? '';
            document.querySelector('app-insights-sheet .backdrop')?.click();
            await new Promise((r) => setTimeout(r, 200));
            return {
                stages,
                frames: Number((chip.match(/([0-9]+)/) ?? [0, 0])[1]),
                mixer: rows.find((row) => row.startsWith('blending')) ?? null,
                matcher: rows.find((row) => row.startsWith('matching')) ?? null,
                detector: rows.find((row) => row.startsWith('detection')) ?? null,
            };
        })()
    `);

function average(samples) {
    if (samples.length === 0) return [];
    return samples[0].map(([name], stage) => [
        name,
        Math.round(samples.reduce((sum, sample) => sum + sample[stage][1], 0) / samples.length),
    ]);
}

async function session(gpu, shots) {
    await setGpu(gpu);
    await reset();
    const samples = [];
    let last = { stages: [], frames: 0, mixer: null, matcher: null, detector: null };
    for (let shot = 0; shot < shots; shot++) {
        await shoot();
        await wait(1700);
        last = await readInsights();
        const integrated = last.stages.find(([name]) => name === 'compose');
        if (integrated && integrated[1] > 0) samples.push(last.stages);
    }
    return { ...last, samples };
}

const withGpu = await session(true, SHOTS);
const withoutGpu = await session(false, SHOTS);
const common = Math.min(withGpu.samples.length, withoutGpu.samples.length);
const renderer = await evaluate(`
    (() => {
        const gl = document.createElement('canvas').getContext('webgl2');
        const info = gl && gl.getExtension('WEBGL_debug_renderer_info');
        return gl ? String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER)) : 'n/a';
    })()
`);

console.log('renderer:', renderer);
for (const [name, run] of [
    ['GPU', withGpu],
    ['CPU', withoutGpu],
]) {
    console.log(`${name} — ${common} merged frames compared`);
    console.log(`  ${run.mixer}`);
    console.log(`  ${run.matcher}`);
    console.log(`  ${run.detector}`);
    console.log(`  stages (ms, mean) ${JSON.stringify(average(run.samples.slice(0, common)))}`);
}

socket.close();
chrome.kill('SIGKILL');
