import {
    ChangeDetectionStrategy,
    Component,
    ElementRef,
    OnDestroy,
    afterNextRender,
    computed,
    effect,
    inject,
    output,
    signal,
    viewChild,
} from '@angular/core';
import { CameraService } from '../../core/services/camera-service';
import { FrameProbe, waitForSteadyFrame } from '../../core/services/steady-frame';
import { StitcherService } from '../../core/services/stitcher-service';

const STEADY_TIMEOUT_MS = 500;

@Component({
    selector: 'app-camera-stage',
    templateUrl: './camera-stage.html',
    styleUrl: './camera-stage.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CameraStage implements OnDestroy {
    private readonly camera = inject(CameraService);
    private readonly stitcher = inject(StitcherService);
    private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');

    readonly openSettings = output<void>();
    readonly openInsights = output<void>();
    readonly requestReset = output<void>();
    readonly openMatch = output<void>();

    readonly switching = signal(false);
    readonly steadying = signal(false);
    readonly exposureLocked = this.camera.exposureLocked;
    readonly notice = this.stitcher.notice;

    readonly active = this.camera.active;
    readonly cameraError = this.camera.error;
    readonly busy = this.stitcher.busy;
    readonly frames = this.stitcher.acceptedFrames;
    readonly dropped = this.stitcher.rejectedFrames;
    readonly pipelineError = this.stitcher.error;

    readonly enoughOverlap = computed(() => {
        if (this.frames() === 0) return true;
        const preview = this.stitcher.preview();
        return preview === null || preview.verified;
    });
    readonly canShoot = computed(
        () => this.active() && !this.busy() && !this.steadying() && this.enoughOverlap(),
    );
    readonly canSwitch = computed(
        () => this.active() && !this.switching() && this.camera.devices().length > 1,
    );
    readonly canCompare = computed(() => this.stitcher.connection() !== null);
    readonly hasWork = computed(() => this.frames() > 0 || this.dropped() > 0);
    readonly shutterTitle = computed(() => {
        if (this.steadying()) return 'Hold still…';
        return this.enoughOverlap() ? 'Take photo' : 'Not enough overlap';
    });

    constructor() {
        effect(() => {
            if (!this.hasWork()) void this.camera.unlockExposure();
        });
        afterNextRender(async () => {
            if (!this.camera.active() && (await this.camera.permissionGranted())) {
                await this.open();
            }
        });
    }

    async open(): Promise<void> {
        await this.attach(await this.camera.open());
    }

    async shoot(): Promise<void> {
        const element = this.video()?.nativeElement;
        if (!element || !this.canShoot()) return;
        this.steadying.set(true);
        try {
            if (!this.hasWork()) {
                const probe = new FrameProbe();
                await this.camera.lockExposure(() => probe.brightness(element));
            }
            await waitForSteadyFrame(element, STEADY_TIMEOUT_MS);
        } finally {
            this.steadying.set(false);
        }
        element.pause();
        try {
            await this.stitcher.capture(element);
        } finally {
            await element.play().catch(() => undefined);
        }
    }

    async switchCamera(): Promise<void> {
        if (this.switching() || this.hasWork()) return;
        this.switching.set(true);
        try {
            this.stitcher.stopTracking();
            const element = this.video()?.nativeElement;
            if (element) element.srcObject = null;
            await this.attach(await this.camera.switch());
        } finally {
            this.switching.set(false);
        }
    }

    private async attach(stream: MediaStream | null): Promise<void> {
        const element = this.video()?.nativeElement;
        if (!stream || !element) return;
        element.srcObject = stream;
        await element.play().catch(() => undefined);
        this.stitcher.trackLive(element);
    }

    ngOnDestroy(): void {
        this.stitcher.stopTracking();
        this.camera.close();
    }
}
