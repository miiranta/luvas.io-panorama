import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class CameraService {
    private stream: MediaStream | null = null;

    readonly active = signal(false);
    readonly label = signal('');
    readonly error = signal<string | null>(null);
    readonly devices = signal<MediaDeviceInfo[]>([]);
    readonly currentDeviceId = signal<string | null>(null);

    get supported(): boolean {
        return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
    }

    private unavailableReason(): string {
        if (typeof window !== 'undefined' && !window.isSecureContext) {
            return `câmera bloqueada em origem insegura (${location.origin}). Abra em http://localhost ou sirva com HTTPS (npm run start:https).`;
        }
        return 'este navegador não dá acesso à câmera.';
    }

    async open(deviceId?: string): Promise<MediaStream | null> {
        this.error.set(null);
        if (!this.supported) {
            this.error.set(this.unavailableReason());
            return null;
        }
        this.close();
        const constraints: MediaStreamConstraints[] = deviceId
            ? [{ video: { deviceId: { exact: deviceId } }, audio: false }]
            : [
                  {
                      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } },
                      audio: false,
                  },
                  { video: true, audio: false },
              ];
        for (const constraint of constraints) {
            try {
                const stream = await navigator.mediaDevices.getUserMedia(constraint);
                this.stream = stream;
                this.active.set(true);
                const track = stream.getVideoTracks()[0];
                this.label.set(track?.label ?? 'câmera');
                this.currentDeviceId.set(track?.getSettings().deviceId ?? deviceId ?? null);
                void this.refreshDevices();
                return stream;
            } catch (cause) {
                const name = cause instanceof DOMException ? cause.name : '';
                if (name === 'NotAllowedError') {
                    this.error.set('permissão de câmera negada pelo navegador.');
                    this.active.set(false);
                    return null;
                }
                this.error.set(
                    name === 'NotFoundError'
                        ? 'nenhuma câmera encontrada.'
                        : `falha ao abrir a câmera${name ? ` (${name})` : ''}.`,
                );
            }
        }
        this.active.set(false);
        return null;
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
    }
}
