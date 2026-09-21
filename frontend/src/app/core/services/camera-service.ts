import { Injectable, signal } from '@angular/core';

type Facing = 'user' | 'environment';
type MeteringKey = 'exposureMode' | 'whiteBalanceMode';
type MeteringCapabilities = Partial<Record<MeteringKey, string[]>>;

export interface CameraRequest {
    deviceId?: string;
    facing?: Facing;
}

const RELEASE_DELAY = 250;
const LOCK_MODES = ['manual', 'single-shot'];
const LOCK_SETTLE_MS = 350;
const LOCK_BRIGHTNESS_TOLERANCE = Math.log(1.25);
const BUSY_RETRIES = 3;
const BUSY_ERRORS = new Set(['NotReadableError', 'AbortError', 'TrackStartError']);

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const errorName = (cause: unknown) => (cause instanceof DOMException ? cause.name : '');

@Injectable({ providedIn: 'root' })
export class CameraService {
    private stream: MediaStream | null = null;
    private lastFailure = '';

    readonly active = signal(false);
    readonly label = signal('');
    readonly error = signal<string | null>(null);
    readonly devices = signal<MediaDeviceInfo[]>([]);
    readonly currentDeviceId = signal<string | null>(null);
    readonly facing = signal<Facing | null>(null);
    readonly exposureLocked = signal(false);

    get supported(): boolean {
        return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
    }

    private unavailableReason(): string {
        if (typeof window !== 'undefined' && !window.isSecureContext) {
            return `camera blocked on an insecure origin (${location.origin}). Open it on http://localhost or serve it over HTTPS (npm run start:https).`;
        }
        return 'this browser does not provide camera access.';
    }

    async permissionGranted(): Promise<boolean> {
        if (!this.supported) return false;
        try {
            const status = await navigator.permissions.query({ name: 'camera' as PermissionName });
            return status.state === 'granted';
        } catch {
            await this.refreshDevices();
            return this.devices().some((device) => device.label !== '');
        }
    }

    async open(request: CameraRequest = {}): Promise<MediaStream | null> {
        this.error.set(null);
        this.lastFailure = '';
        if (!this.supported) {
            this.error.set(this.unavailableReason());
            return null;
        }
        const hadStream = this.stream !== null;
        this.close();
        if (hadStream) await delay(RELEASE_DELAY);
        for (const constraint of this.constraintsFor(request)) {
            try {
                const stream = await this.acquire(constraint);
                this.stream = stream;
                this.active.set(true);
                const track = stream.getVideoTracks()[0];
                const settings = track?.getSettings() ?? {};
                this.label.set(track?.label ?? 'camera');
                this.currentDeviceId.set(settings.deviceId ?? request.deviceId ?? null);
                this.facing.set(
                    settings.facingMode === 'user' || settings.facingMode === 'environment'
                        ? settings.facingMode
                        : (request.facing ?? null),
                );
                void this.refreshDevices();
                return stream;
            } catch (cause) {
                const name = errorName(cause);
                this.lastFailure = name;
                if (name === 'NotAllowedError') {
                    this.error.set('camera permission denied by the browser.');
                    this.active.set(false);
                    return null;
                }
                this.error.set(this.describe(name));
            }
        }
        this.active.set(false);
        return null;
    }

    async switch(): Promise<MediaStream | null> {
        const previous = this.currentDeviceId();
        const facing = this.facing();
        const requests: CameraRequest[] = [];
        if (facing) requests.push({ facing: facing === 'user' ? 'environment' : 'user' });
        const next = this.nextDeviceId();
        if (next) requests.push({ deviceId: next });
        for (const request of requests) {
            const stream = await this.open(request);
            if (stream) return stream;
            if (this.lastFailure === 'NotAllowedError') return null;
        }
        if (!previous) return null;
        const reason = this.error();
        const restored = await this.open({ deviceId: previous });
        if (restored) this.error.set(`could not switch camera — ${reason ?? 'failed'}`);
        return restored;
    }

    nextDeviceId(): string | null {
        const devices = this.devices();
        if (devices.length < 2) return null;
        const current = this.currentDeviceId();
        const index = devices.findIndex((device) => device.deviceId === current);
        return devices[(index + 1) % devices.length]?.deviceId ?? null;
    }

    async refreshDevices(): Promise<void> {
        if (!navigator.mediaDevices?.enumerateDevices) return;
        const all = await navigator.mediaDevices.enumerateDevices();
        this.devices.set(all.filter((device) => device.kind === 'videoinput'));
    }

    close(): void {
        this.stream?.getTracks().forEach((track) => track.stop());
        this.stream = null;
        this.active.set(false);
        this.exposureLocked.set(false);
    }

    async lockExposure(brightness: () => number | null): Promise<boolean> {
        const track = this.stream?.getVideoTracks()[0];
        if (!track || this.exposureLocked()) return false;
        const whiteBalance = this.lockMode(track, 'whiteBalanceMode');
        const balanced =
            whiteBalance !== null &&
            (await this.applyMetering(track, { whiteBalanceMode: whiteBalance }));
        const exposure = this.lockMode(track, 'exposureMode');
        const before = brightness();
        const exposed =
            exposure !== null && (await this.applyMetering(track, { exposureMode: exposure }));
        if (exposed) {
            await delay(LOCK_SETTLE_MS);
            const after = brightness();
            if (before && after && Math.abs(Math.log(after / before)) > LOCK_BRIGHTNESS_TOLERANCE) {
                await this.applyMetering(track, { exposureMode: 'continuous' });
                this.exposureLocked.set(balanced);
                return false;
            }
        }
        this.exposureLocked.set(balanced || exposed);
        return this.exposureLocked();
    }

    async unlockExposure(): Promise<void> {
        const track = this.stream?.getVideoTracks()[0];
        if (!track || !this.exposureLocked()) return;
        this.exposureLocked.set(false);
        const release: Partial<Record<MeteringKey, string>> = {};
        for (const key of ['exposureMode', 'whiteBalanceMode'] as const) {
            if (this.capabilities(track)[key]?.includes('continuous')) release[key] = 'continuous';
        }
        await this.applyMetering(track, release);
    }

    private capabilities(track: MediaStreamTrack): MeteringCapabilities {
        return typeof track.getCapabilities === 'function'
            ? (track.getCapabilities() as MeteringCapabilities)
            : {};
    }

    private lockMode(track: MediaStreamTrack, key: MeteringKey): string | null {
        const modes = this.capabilities(track)[key] ?? [];
        return LOCK_MODES.find((mode) => modes.includes(mode)) ?? null;
    }

    private async applyMetering(
        track: MediaStreamTrack,
        metering: Partial<Record<MeteringKey, string>>,
    ): Promise<boolean> {
        if (Object.keys(metering).length === 0) return false;
        try {
            await track.applyConstraints({ advanced: [metering as MediaTrackConstraintSet] });
            return true;
        } catch {
            return false;
        }
    }

    private constraintsFor({ deviceId, facing }: CameraRequest): MediaStreamConstraints[] {
        if (deviceId) return [{ video: { deviceId: { exact: deviceId } }, audio: false }];
        if (facing) {
            return [
                { video: { facingMode: { exact: facing }, width: { ideal: 1920 } }, audio: false },
            ];
        }
        return [
            {
                video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } },
                audio: false,
            },
            { video: true, audio: false },
        ];
    }

    private async acquire(constraint: MediaStreamConstraints): Promise<MediaStream> {
        for (let attempt = 0; ; attempt++) {
            try {
                return await navigator.mediaDevices.getUserMedia(constraint);
            } catch (cause) {
                if (attempt >= BUSY_RETRIES || !BUSY_ERRORS.has(errorName(cause))) throw cause;
                await delay(RELEASE_DELAY * (attempt + 1));
            }
        }
    }

    private describe(name: string): string {
        if (name === 'NotFoundError' || name === 'OverconstrainedError') {
            return 'no camera found.';
        }
        if (BUSY_ERRORS.has(name)) {
            return 'camera busy — close other apps or tabs that are using it.';
        }
        return `failed to open the camera${name ? ` (${name})` : ''}.`;
    }
}
