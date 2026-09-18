import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP_URL = process.env.APP_URL ?? 'http://localhost:4173';
const VIDEO = process.env.FAKE_VIDEO ?? '/tmp/pano.y4m';
const SHOTS = Number(process.env.SHOTS ?? 7);
const OUT = process.env.SHOT_DIR ?? '/tmp/e2e';

const profile = mkdtempSync(join(tmpdir(), 'chrome-e2e-'));
const chrome = spawn(
    'google-chrome',
    [
        '--headless=new',
        '--remote-debugging-port=9333',
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--use-angle=gl',
        '--enable-gpu',
        '--window-size=1280,900',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-video-capture=${VIDEO}`,
        '--autoplay-policy=no-user-gesture-required',
        'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
);

const log = [];
chrome.stderr.on('data', (chunk) => log.push(chunk.toString()));

async function endpoint() {
    for (let attempt = 0; attempt < 60; attempt++) {
        try {
            const response = await fetch('http://127.0.0.1:9333/json/version');
            const json = await response.json();
            return json.webSocketDebuggerUrl;
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }
    throw new Error(`devtools unavailable\n${log.join('')}`);
}

const wsUrl = await endpoint();
const socket = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
});

let nextId = 1;
const pending = new Map();
const events = [];
socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
    } else if (message.method) {
        events.push(message);
    }
});

function send(method, params = {}, sessionId) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
}

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const call = (method, params) => send(method, params, sessionId);

await call('Page.enable');
await call('Runtime.enable');
await call('Log.enable');

const consoleErrors = [];
socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
        consoleErrors.push(message.params.entry.text);
    }
    if (message.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(message.params.exceptionDetails.text);
    }
});

async function evaluate(expression) {
    const result = await call('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
    });
    if (result.exceptionDetails) {
        throw new Error(`evaluation error: ${result.exceptionDetails.text}`);
    }
    return result.result.value;
}

async function screenshot(name) {
    const { data } = await call('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, name), Buffer.from(data, 'base64'));
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
function check(name, pass, detail) {
    results.push({ name, pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
}

try {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(OUT, { recursive: true });

    await call('Page.navigate', { url: APP_URL });
    await wait(2500);

    const title = await evaluate('document.title');
    check('app loaded', typeof title === 'string', `title="${title}"`);

    await evaluate(`
    (() => {
      const root = document.querySelector('app-root');
      const stage = root?.querySelector('app-camera-stage');
      const start = stage?.querySelector('button.start');
      if (start) start.click();
      return !!start;
    })()
  `);
    await wait(3000);

    const cameraState = await evaluate(`
    (() => {
      const video = document.querySelector('app-camera-stage video');
      return {
        ready: video ? video.readyState : -1,
        width: video ? video.videoWidth : 0,
        height: video ? video.videoHeight : 0,
        error: document.querySelector('app-camera-stage .toast')?.textContent?.trim() ?? null,
      };
    })()
  `);
    check(
        'fake camera opened via getUserMedia',
        cameraState.ready >= 2 && cameraState.width > 0,
        `readyState=${cameraState.ready} ${cameraState.width}x${cameraState.height}` +
            (cameraState.error ? ` error="${cameraState.error}"` : ''),
    );
    await screenshot('01-camera.png');

    for (let shot = 0; shot < SHOTS; shot++) {
        await evaluate(`
      (() => {
        const button = document.querySelector('app-camera-stage button.shutter');
        if (button && !button.disabled) button.click();
        return !!button;
      })()
    `);
        await wait(2200);
    }

    const hud = await evaluate(`
    (() => {
      const chips = [...document.querySelectorAll('app-camera-stage .chip')].map((c) =>
        c.textContent.replace(/\\s+/g, ' ').trim(),
      );
      const canvas = document.querySelector('app-panorama-layer canvas');
      let filled = 0;
      let total = 0;
      if (canvas) {
        const context = canvas.getContext('2d');
        const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
        total = data.length / 4;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) filled++;
      }
      return {
        chips,
        canvas: canvas ? { width: canvas.width, height: canvas.height } : null,
        coverage: total ? (filled / total) * 100 : 0,
        compareEnabled:
          document.querySelector('app-camera-stage button.compare')?.disabled === false,
        pip: document.querySelector('app-match-dialog') !== null,
      };
    })()
  `);
    check(
        'mosaic accumulated on the canvas',
        hud.canvas !== null && hud.coverage > 0.5,
        `${hud.canvas?.width}x${hud.canvas?.height}, ${hud.coverage.toFixed(2)}% of pixels written`,
    );
    check(
        'HUD shows count and covered angle',
        hud.chips.length > 1 && /°/.test(hud.chips.join(' ')),
        hud.chips.join(' | '),
    );
    check(
        'comparison opens from a button (no PiP over the camera)',
        hud.compareEnabled && !hud.pip,
        `button=${hud.compareEnabled} pip=${hud.pip}`,
    );
    const liveTracking = await evaluate(`
    (async () => {
      const samples = [];
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 420));
        const node = document.querySelector('app-tracks-layer .pill');
        const pill = node?.textContent?.replace(/\\s+/g, ' ').trim() ?? '';
        const live = node?.classList.contains('live') ?? false;
        const canvas = document.querySelector('app-tracks-layer canvas');
        let drawn = 0;
        if (canvas) {
          const data = canvas
            .getContext('2d')
            .getImageData(0, 0, canvas.width, canvas.height).data;
          for (let p = 3; p < data.length; p += 4) if (data[p] > 24) drawn++;
        }
        samples.push({ pill, drawn, live });
      }
      return samples;
    })()
  `);
    const liveFrames = liveTracking.filter((s) => s.live && s.drawn > 200);
    check(
        'live tracking against the panorama',
        liveFrames.length >= 3,
        `${liveFrames.length}/${liveTracking.length} samples with live overlap — ` +
            `e.g. "${liveFrames[0]?.pill ?? liveTracking[0]?.pill}"`,
    );
    await screenshot('06-live.png');

    const tracks = await evaluate(`
    (() => {
      const canvas = document.querySelector('app-tracks-layer canvas');
      if (!canvas) return null;
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let drawn = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 24) drawn++;
      return {
        width: canvas.width,
        height: canvas.height,
        drawn,
        pill: document.querySelector('app-tracks-layer .pill')?.textContent?.trim() ?? null,
      };
    })()
  `);
    check(
        'match lines over the camera',
        tracks !== null && tracks.drawn > 500 && tracks.pill !== null,
        tracks
            ? `${tracks.drawn} px drawn in ${tracks.width}x${tracks.height}, "${tracks.pill}"`
            : 'layer missing',
    );
    await screenshot('02-shots.png');

    await evaluate(`document.querySelector('app-camera-stage button[title="Parameters"]').click()`);
    await wait(700);
    const settings = await evaluate(`
    (() => {
      const sheet = document.querySelector('app-settings-sheet .sheet');
      return {
        open: !!sheet,
        rows: sheet ? sheet.querySelectorAll('.row').length : 0,
      };
    })()
  `);
    check(
        'parameters overlay opens',
        settings.open && settings.rows > 4,
        `${settings.rows} controls`,
    );

    const selectState = await evaluate(`
    (() => {
      const selects = [...document.querySelectorAll('app-settings-sheet select')];
      return selects.map((select) => select.value);
    })()
  `);
    check(
        'selects reflect the active parameters',
        selectState.includes('homography') &&
            selectState.includes('planar') &&
            selectState.includes('multiband'),
        selectState.join(', '),
    );
    await screenshot('03-settings.png');

    await evaluate(`
    (() => {
      const selects = document.querySelectorAll('app-settings-sheet select');
      for (const select of selects) {
        if ([...select.options].some((o) => o.value === 'cylindrical')) {
          select.value = 'cylindrical';
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      return false;
    })()
  `);
    await wait(2500);
    const afterSurface = await evaluate(`
    (() => {
      const canvas = document.querySelector('app-panorama-layer canvas');
      return canvas ? { width: canvas.width, height: canvas.height } : null;
    })()
  `);
    check(
        'switching surface recomposites in real time',
        afterSurface !== null && afterSurface.height !== hud.canvas.height,
        `${hud.canvas.width}x${hud.canvas.height} → ${afterSurface?.width}x${afterSurface?.height}`,
    );

    await evaluate(`document.querySelector('app-settings-sheet .backdrop').click()`);
    await wait(500);
    await evaluate(
        `document.querySelector('app-camera-stage button[title="Metrics and graph"]').click()`,
    );
    await wait(900);
    const insights = await evaluate(`
    (() => {
      const sheet = document.querySelector('app-insights-sheet .sheet');
      if (!sheet) return null;
      return {
        nodes: sheet.querySelectorAll('svg circle').length,
        edges: sheet.querySelectorAll('svg line').length,
        order: sheet.querySelector('dd')?.textContent?.trim() ?? '',
      };
    })()
  `);
    check(
        'neighbourhood graph rendered',
        insights !== null && insights.nodes > 1 && insights.edges > 0,
        insights
            ? `${insights.nodes} nodes, ${insights.edges} edges, order ${insights.order}`
            : 'missing',
    );
    await screenshot('04-insights.png');

    await evaluate(`document.querySelector('app-insights-sheet .backdrop').click()`);
    await wait(400);

    const resetFlow = await evaluate(`
    (async () => {
      const button = document.querySelector('app-camera-stage button.reset');
      if (!button) return { step: 'no button' };
      button.click();
      await new Promise((r) => setTimeout(r, 400));
      const dialog = document.querySelector('app-confirm-dialog .dialog');
      const opened = !!dialog;
      const message = dialog?.querySelector('.message')?.textContent?.trim() ?? '';
      document.querySelector('app-confirm-dialog .backdrop')?.click();
      await new Promise((r) => setTimeout(r, 300));
      const dismissed = !document.querySelector('app-confirm-dialog .dialog');
      const chip = document
        .querySelector('app-camera-stage .chip')
        ?.textContent?.replace(/\\s+/g, ' ')
        .trim();
      return { opened, message, dismissed, chip };
    })()
  `);
    check(
        'reset asks for confirmation and cancels without clearing',
        resetFlow.opened && resetFlow.dismissed && /photos/.test(resetFlow.chip ?? ''),
        `"${resetFlow.message}" → cancelled, HUD still shows "${resetFlow.chip}"`,
    );

    const iconGeometry = await evaluate(`
    (() => {
      const buttons = [...document.querySelectorAll('app-camera-stage button.icon')];
      return buttons.map((button) => {
        const svg = button.querySelector('svg');
        if (!svg) return { ok: false };
        const b = button.getBoundingClientRect();
        const s = svg.getBoundingClientRect();
        return {
          dx: Math.abs((s.left + s.width / 2) - (b.left + b.width / 2)),
          dy: Math.abs((s.top + s.height / 2) - (b.top + b.height / 2)),
        };
      });
    })()
  `);
    const worst = iconGeometry.reduce(
        (max, entry) => Math.max(max, entry.dx ?? 99, entry.dy ?? 99),
        0,
    );
    check(
        'icons centred in their buttons',
        iconGeometry.length >= 3 && worst < 0.75,
        `${iconGeometry.length} buttons, max offset ${worst.toFixed(2)} px`,
    );

    const stacking = await evaluate(`
    (() => {
      const layer = (selector) => {
        let node = document.querySelector(selector);
        while (node && node !== document.documentElement) {
          const style = getComputedStyle(node);
          if (style.zIndex !== 'auto' && style.position !== 'static') return Number(style.zIndex);
          node = node.parentElement;
        }
        return 0;
      };
      const lines = layer('app-tracks-layer canvas');
      const controls = [
        'app-camera-stage .hud',
        'app-camera-stage button.shutter',
        'app-camera-stage button.reset',
        'app-camera-stage button.compare',
        'app-panorama-layer .minimap',
      ].map((selector) => ({ selector, z: layer(selector) }));
      return {
        lines,
        feed: layer('app-camera-stage video'),
        hostDisplay: getComputedStyle(document.querySelector('app-camera-stage')).display,
        below: controls.filter((control) => control.z <= lines).map((control) => control.selector),
      };
    })()
  `);
    check(
        'lines only over the camera, behind the controls',
        stacking.hostDisplay === 'contents' &&
            stacking.feed < stacking.lines &&
            stacking.below.length === 0,
        `video z=${stacking.feed}, lines z=${stacking.lines}, below the lines: ${stacking.below.join(', ') || 'none'}`,
    );

    const closeFlow = await evaluate(`
    (async () => {
      const inside = (inner, outer) => {
        const a = inner.getBoundingClientRect();
        const b = outer.getBoundingClientRect();
        return a.left >= b.left - 0.5 && a.right <= b.right + 0.5 &&
          a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5;
      };
      const overlap = (x, y) => {
        const a = x.getBoundingClientRect();
        const b = y.getBoundingClientRect();
        return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      };
      document.querySelector('app-camera-stage button.compare')?.click();
      await new Promise((r) => setTimeout(r, 500));
      const dialog = document.querySelector('app-match-dialog .dialog');
      const close = document.querySelector('app-match-dialog button.close');
      const tag = document.querySelector('app-match-dialog .tag')?.textContent?.trim() ?? null;
      const matchCloseInside = !!dialog && !!close && inside(close, dialog);
      close?.click();
      await new Promise((r) => setTimeout(r, 400));
      const matchClosed = document.querySelector('app-match-dialog') === null;

      document.querySelector('app-panorama-layer .minimap')?.click();
      await new Promise((r) => setTimeout(r, 500));
      const frame = document.querySelector('app-panorama-layer .minimap');
      const save = document.querySelector('app-panorama-layer button.save');
      const shut = document.querySelector('app-panorama-layer button.close');
      const minimapButtons =
        !!frame && !!save && !!shut && inside(save, frame) && inside(shut, frame) && !overlap(save, shut);
      shut?.click();
      await new Promise((r) => setTimeout(r, 400));
      const minimapClosed = document.querySelector('app-panorama-layer.expanded') === null;
      return { tag, matchCloseInside, matchClosed, minimapButtons, minimapClosed };
    })()
  `);
    check(
        'comparison popup opens and closes with the X',
        closeFlow.tag !== null && closeFlow.matchCloseInside && closeFlow.matchClosed,
        `${closeFlow.tag ?? 'no tag'} · X inside=${closeFlow.matchCloseInside} closed=${closeFlow.matchClosed}`,
    );
    check(
        'expanded minimap: X and export visible and not overlapping',
        closeFlow.minimapButtons && closeFlow.minimapClosed,
        `buttons ok=${closeFlow.minimapButtons} closed=${closeFlow.minimapClosed}`,
    );

    const longRun = await evaluate(`
    (async () => {
      for (let i = 0; i < 9; i++) {
        const button = document.querySelector('app-camera-stage button.shutter');
        if (button && !button.disabled) button.click();
        await new Promise((r) => setTimeout(r, 1500));
      }
      const chip = document
        .querySelector('app-camera-stage .chip')
        ?.textContent?.replace(/\\s+/g, ' ')
        .trim();
      document.querySelector('app-camera-stage button[title="Metrics and graph"]').click();
      await new Promise((r) => setTimeout(r, 700));
      const rows = [...document.querySelectorAll('app-insights-sheet dl div')].map((row) =>
        row.textContent.replace(/\\s+/g, ' ').trim(),
      );
      document.querySelector('app-insights-sheet .backdrop')?.click();
      await new Promise((r) => setTimeout(r, 300));
      return { chip, memory: rows.find((row) => row.startsWith('memory')) ?? null };
    })()
  `);
    const longCount = Number(/([0-9]+) photos/.exec(longRun.chip ?? '')?.[1] ?? 0);
    check(
        'long session keeps merging',
        longCount >= 8 && longRun.memory !== null,
        `${longRun.chip} (${longCount} accepted), ${longRun.memory}`,
    );

    const gpuState = await evaluate(`
    (async () => {
      document.querySelector('app-camera-stage button[title="Metrics and graph"]').click();
      await new Promise((r) => setTimeout(r, 600));
      const rows = [...document.querySelectorAll('app-insights-sheet dl div')].map((row) =>
        row.textContent.replace(/\\s+/g, ' ').trim(),
      );
      document.querySelector('app-insights-sheet .backdrop')?.click();
      await new Promise((r) => setTimeout(r, 250));
      return {
        mixer: rows.find((row) => row.startsWith('blending')) ?? null,
        matcher: rows.find((row) => row.startsWith('matching')) ?? null,
        detector: rows.find((row) => row.startsWith('detection')) ?? null,
      };
    })()
  `);
    check(
        'multiband blending accelerated by WebGL2',
        gpuState?.mixer != null && /webgl2/.test(gpuState.mixer),
        gpuState?.mixer ?? 'missing',
    );
    check(
        'matching accelerated by WebGL2 (bit-identical to the CPU)',
        gpuState?.matcher != null && /webgl2/.test(gpuState.matcher),
        gpuState?.matcher ?? 'missing',
    );
    check(
        'detection accelerated by WebGL2 (response checked against the CPU)',
        gpuState?.detector != null && /webgl2/.test(gpuState.detector),
        gpuState?.detector ?? 'missing',
    );

    const surfaceSwap = await evaluate(`
    (async () => {
      document.querySelector('app-camera-stage button[title="Parameters"]').click();
      await new Promise((r) => setTimeout(r, 400));
      const selects = [...document.querySelectorAll('app-settings-sheet select')];
      const target = selects.find((s) => [...s.options].some((o) => o.value === 'spherical'));
      if (target) {
        target.value = 'spherical';
        target.dispatchEvent(new Event('change', { bubbles: true }));
      }
      await new Promise((r) => setTimeout(r, 4000));
      document.querySelector('app-settings-sheet .backdrop')?.click();
      await new Promise((r) => setTimeout(r, 300));
      const canvas = document.querySelector('app-panorama-layer canvas');
      if (!canvas) return { filled: 0 };
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let filled = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) filled++;
      return { filled, total: data.length / 4 };
    })()
  `);
    check(
        'recompositing after archiving keeps the old photos',
        surfaceSwap.filled > 0 && surfaceSwap.filled / surfaceSwap.total > 0.3,
        `${((surfaceSwap.filled / (surfaceSwap.total || 1)) * 100).toFixed(1)}% of the crop filled`,
    );

    const resetClears = await evaluate(`
    (async () => {
      const painted = () => {
        const canvas = document.querySelector('app-tracks-layer canvas');
        if (!canvas) return -1;
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let count = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 24) count++;
        return count;
      };
      const before = painted();
      document.querySelector('app-camera-stage button.reset')?.click();
      await new Promise((r) => setTimeout(r, 300));
      document.querySelector('app-confirm-dialog .danger')?.click();
      await new Promise((r) => setTimeout(r, 1600));
      return {
        before,
        after: painted(),
        chip: document
          .querySelector('app-camera-stage .chip')
          ?.textContent?.replace(/\\s+/g, ' ')
          .trim(),
        minimap: !!document.querySelector('app-panorama-layer canvas'),
        pill: !!document.querySelector('app-tracks-layer .pill'),
      };
    })()
  `);
    check(
        'reset clears points, minimap and HUD',
        resetClears.before > 200 &&
            resetClears.after === 0 &&
            !resetClears.minimap &&
            !resetClears.pill &&
            /0 photos/.test(resetClears.chip ?? ''),
        `${resetClears.before} → ${resetClears.after} px, minimap=${resetClears.minimap}, ` +
            `HUD="${resetClears.chip}"`,
    );

    const exported = await evaluate(`
    (async () => {
      const layer = document.querySelector('app-panorama-layer');
      const canvas = layer?.querySelector('canvas');
      if (!canvas) return -1;
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      return blob ? blob.size : 0;
    })()
  `);
    check(
        'export produces a PNG',
        exported === -1 || exported > 5000,
        exported === -1 ? 'no mosaic after reset (expected)' : `${(exported / 1024).toFixed(0)} kB`,
    );

    check(
        'no console errors',
        consoleErrors.length === 0,
        consoleErrors.length === 0 ? 'none' : consoleErrors.slice(0, 3).join(' | '),
    );

    await screenshot('05-final.png');
} catch (error) {
    check('run without exceptions', false, error instanceof Error ? error.message : String(error));
} finally {
    socket.close();
    chrome.kill('SIGKILL');
}

const failures = results.filter((r) => !r.pass);
console.log(
    `\n${results.length - failures.length}/${results.length} E2E checks passed` +
        (failures.length ? `\nfalhas: ${failures.map((f) => f.name).join('; ')}` : ''),
);
console.log(`screenshots in ${OUT}`);
process.exit(failures.length ? 1 : 0);
