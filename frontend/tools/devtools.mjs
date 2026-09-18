import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CONNECT_ATTEMPTS = 80;
const CONNECT_INTERVAL_MS = 250;

async function debuggerUrl(port, log) {
    for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt++) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/version`);
            return (await response.json()).webSocketDebuggerUrl;
        } catch {
            await new Promise((resolve) => setTimeout(resolve, CONNECT_INTERVAL_MS));
        }
    }
    throw new Error(`devtools unavailable\n${log.join('')}`);
}

export async function openChrome({ name, port, video, softwareGl = false }) {
    const profile = mkdtempSync(join(tmpdir(), `chrome-${name}-`));
    const graphics = softwareGl
        ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
        : ['--use-angle=gl', '--enable-gpu'];
    const chrome = spawn(
        'google-chrome',
        [
            '--headless=new',
            `--remote-debugging-port=${port}`,
            `--user-data-dir=${profile}`,
            '--no-first-run',
            '--no-default-browser-check',
            '--window-size=1280,900',
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            `--use-file-for-fake-video-capture=${video}`,
            '--autoplay-policy=no-user-gesture-required',
            ...graphics,
            'about:blank',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const log = [];
    chrome.stderr.on('data', (chunk) => log.push(chunk.toString()));

    const socket = new WebSocket(await debuggerUrl(port, log));
    await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
    });

    let nextId = 1;
    const pending = new Map();
    socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (!message.id || !pending.has(message.id)) return;
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
    });

    const send = (method, params = {}, sessionId) =>
        new Promise((resolve, reject) => {
            const id = nextId++;
            pending.set(id, { resolve, reject });
            socket.send(JSON.stringify({ id, method, params, sessionId }));
        });

    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const call = (method, params) => send(method, params, sessionId);
    await call('Page.enable');
    await call('Runtime.enable');

    const evaluate = async (expression) => {
        const result = await call('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
        });
        if (result.exceptionDetails) {
            throw new Error(`evaluation error: ${result.exceptionDetails.text}`);
        }
        return result.result.value;
    };

    const close = () => {
        socket.close();
        chrome.kill('SIGKILL');
    };

    return { socket, send, call, evaluate, close };
}
