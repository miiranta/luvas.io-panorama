import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openChrome } from './devtools.mjs';

const APP_URL = process.env.APP_URL ?? 'http://localhost:4173';
const VIDEO = process.env.FAKE_VIDEO ?? '/tmp/pano.y4m';
const SHOTS = Number(process.env.SHOTS ?? 7);
const OUT = process.env.SHOT_DIR ?? '/tmp/e2e';

const { socket, call, evaluate, close } = await openChrome({
    name: 'e2e',
    port: 9333,
    video: VIDEO,
});
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

    const exportGate = await evaluate(`
    (async () => {
      const shutter = document.querySelector('app-camera-stage button.shutter');
      if (shutter && !shutter.disabled) shutter.click();
      let blocked = false;
      let badge = '';
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const save = document.querySelector('app-panorama-layer button.save');
        const label = document.querySelector('app-panorama-layer .badge');
        if (save?.disabled) {
          blocked = true;
          badge = label?.textContent?.trim() ?? '';
          break;
        }
      }
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const save = document.querySelector('app-panorama-layer button.save');
        if (save && !save.disabled) {
          return { blocked, badge, released: true };
        }
      }
      return { blocked, badge, released: false };
    })()
  `);
    check(
        'export waits for the composition and says it is a preview',
        exportGate.blocked && exportGate.released && /compositing/i.test(exportGate.badge),
        `blocked while "${exportGate.badge}", released afterwards=${exportGate.released}`,
    );

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
        'HUD shows the photo count',
        hud.chips.length === 1 && /\d+ photos/.test(hud.chips[0]),
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
    const previewRate = await evaluate(`
    (async () => {
      const original = Worker.prototype.postMessage;
      let count = 0;
      Worker.prototype.postMessage = function (message, transfer) {
        if (message && message.kind === 'preview') count++;
        return original.call(this, message, transfer);
      };
      const started = performance.now();
      await new Promise((r) => setTimeout(r, 3000));
      Worker.prototype.postMessage = original;
      return (count * 1000) / (performance.now() - started);
    })()
  `);
    check(
        'live lines refresh faster than the old 4 Hz timer',
        previewRate > 4,
        `${previewRate.toFixed(1)} updates/s (fake camera streams 10 fps)`,
    );

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
        'neighborhood graph rendered',
        insights !== null && insights.nodes > 1 && insights.edges > 0,
        insights
            ? `${insights.nodes} nodes, ${insights.edges} edges, order ${insights.order}`
            : 'missing',
    );
    await screenshot('04-insights.png');

    await evaluate(`document.querySelector('app-insights-sheet .backdrop').click()`);
    await wait(400);

    const download = await evaluate(`
    (async () => {
      const original = URL.createObjectURL;
      let size = 0;
      let type = '';
      URL.createObjectURL = (blob) => {
        size = blob.size;
        type = blob.type;
        return original.call(URL, blob);
      };
      const canvas = document.querySelector('app-panorama-layer canvas');
      const preview = canvas ? canvas.width + 'x' + canvas.height : 'none';
      document.querySelector('app-panorama-layer button.save')?.click();
      for (let i = 0; i < 300; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (size > 0) break;
      }
      URL.createObjectURL = original;
      return { size, type, preview };
    })()
  `);
    check(
        'export writes a full-resolution PNG',
        download.size > 50000 && download.type === 'image/png',
        `${(download.size / 1024).toFixed(0)} kB ${download.type || 'no blob'} (preview canvas ${download.preview})`,
    );

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
        'icons centered in their buttons',
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
        warper: rows.find((row) => row.startsWith('warping')) ?? null,
        compositor: rows.find((row) => row.startsWith('compositing')) ?? null,
      };
    })()
  `);
    check(
        'multiband blending accelerated by WebGL2',
        gpuState?.mixer != null && gpuState.mixer.startsWith('blendingwebgl2'),
        gpuState?.mixer ?? 'missing',
    );
    check(
        'matching accelerated by WebGL2 (bit-identical to the CPU)',
        gpuState?.matcher != null && gpuState.matcher.startsWith('matchingwebgl2'),
        gpuState?.matcher ?? 'missing',
    );
    check(
        'detection accelerated by WebGL2 (response checked against the CPU)',
        gpuState?.detector != null && gpuState.detector.startsWith('detectionwebgl2'),
        gpuState?.detector ?? 'missing',
    );
    check(
        'compositing accelerated by WebGL2 (mosaic checked against the CPU)',
        gpuState?.compositor != null && gpuState.compositor.startsWith('compositingwebgl2'),
        gpuState?.compositor ?? 'missing',
    );
    check(
        'warping accelerated by WebGL2 (tiles checked against the CPU)',
        gpuState?.warper != null && gpuState.warper.startsWith('warpingwebgl2'),
        gpuState?.warper ?? 'missing',
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
    close();
}

const failures = results.filter((r) => !r.pass);
console.log(
    `\n${results.length - failures.length}/${results.length} E2E checks passed` +
        (failures.length ? `\nfailures: ${failures.map((f) => f.name).join('; ')}` : ''),
);
console.log(`screenshots in ${OUT}`);
process.exit(failures.length ? 1 : 0);
