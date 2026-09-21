const PROBE_WIDTH = 64;
const PROBE_HEIGHT = 48;
const STEADY_SHIFT = 0.12;
const STEADY_FRAMES = 2;
const FRAME_FALLBACK_MS = 120;

export class FrameProbe {
    private readonly context: OffscreenCanvasRenderingContext2D | null =
        typeof OffscreenCanvas === 'undefined'
            ? null
            : new OffscreenCanvas(PROBE_WIDTH, PROBE_HEIGHT).getContext('2d', {
                  willReadFrequently: true,
              });

    gray(video: HTMLVideoElement): Float32Array | null {
        const context = this.context;
        if (!context || video.readyState < 2 || !video.videoWidth) return null;
        context.drawImage(video, 0, 0, PROBE_WIDTH, PROBE_HEIGHT);
        const { data } = context.getImageData(0, 0, PROBE_WIDTH, PROBE_HEIGHT);
        const gray = new Float32Array(PROBE_WIDTH * PROBE_HEIGHT);
        for (let i = 0; i < gray.length; i++) {
            gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
        }
        return gray;
    }

    brightness(video: HTMLVideoElement): number | null {
        const gray = this.gray(video);
        if (!gray) return null;
        let sum = 0;
        for (const value of gray) sum += value;
        return sum / gray.length;
    }
}

export function frameShift(previous: Float32Array, current: Float32Array): number {
    let change = 0;
    let gradient = 0;
    for (let y = 1; y < PROBE_HEIGHT - 1; y++) {
        for (let x = 1; x < PROBE_WIDTH - 1; x++) {
            const i = y * PROBE_WIDTH + x;
            change += Math.abs(current[i] - previous[i]);
            gradient +=
                0.5 *
                (Math.abs(previous[i + 1] - previous[i - 1]) +
                    Math.abs(previous[i + PROBE_WIDTH] - previous[i - PROBE_WIDTH]));
        }
    }
    return gradient < 1e-6 ? 0 : change / gradient;
}

function nextVideoFrame(video: HTMLVideoElement): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, FRAME_FALLBACK_MS);
        const done = () => {
            clearTimeout(timer);
            resolve();
        };
        if (typeof video.requestVideoFrameCallback === 'function') {
            video.requestVideoFrameCallback(done);
        } else {
            requestAnimationFrame(done);
        }
    });
}

export async function waitForSteadyFrame(
    video: HTMLVideoElement,
    timeoutMs: number,
): Promise<boolean> {
    const probe = new FrameProbe();
    const deadline = performance.now() + timeoutMs;
    let previous = probe.gray(video);
    let clock = video.currentTime;
    let steady = 0;
    while (previous && performance.now() < deadline) {
        await nextVideoFrame(video);
        if (video.currentTime === clock) continue;
        clock = video.currentTime;
        const current = probe.gray(video);
        if (!current) return false;
        steady = frameShift(previous, current) < STEADY_SHIFT ? steady + 1 : 0;
        if (steady >= STEADY_FRAMES) return true;
        previous = current;
    }
    return false;
}
