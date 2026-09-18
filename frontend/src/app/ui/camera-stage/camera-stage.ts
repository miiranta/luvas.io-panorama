import {
    ChangeDetectionStrategy,
    Component,
    ElementRef,
    OnDestroy,
    computed,
    inject,
    output,
    viewChild,
} from '@angular/core';
import { CameraService } from '../../core/services/camera.service';
import { StitcherService } from '../../core/services/stitcher.service';

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

    readonly active = this.camera.active;
    readonly cameraError = this.camera.error;
    readonly busy = this.stitcher.busy;
    readonly frames = this.stitcher.acceptedFrames;
    readonly dropped = this.stitcher.rejectedFrames;
    readonly pipelineError = this.stitcher.error;

    readonly span = computed(() => {
        const mosaic = this.stitcher.mosaic();
        if (!mosaic || mosaic.spanHorizontal < 1) return null;
        return `${Math.round(mosaic.spanHorizontal)}° × ${Math.round(mosaic.spanVertical)}°`;
    });
    readonly enoughOverlap = computed(() => {
        if (this.frames() === 0) return true;
        const preview = this.stitcher.preview();
        return preview === null || preview.verified;
    });
    readonly canShoot = computed(() => this.active() && !this.busy() && this.enoughOverlap());
    readonly canSwitch = computed(() => this.active() && this.camera.devices().length > 1);
    readonly canCompare = computed(() => this.stitcher.connection() !== null);
    readonly hasWork = computed(() => this.frames() > 0 || this.dropped() > 0);

    async open(): Promise<void> {
        const stream = await this.camera.open();
        const element = this.video()?.nativeElement;
        if (!stream || !element) return;
        element.srcObject = stream;
        await element.play().catch(() => undefined);
        this.stitcher.trackLive(element);
    }

    async shoot(): Promise<void> {
        const element = this.video()?.nativeElement;
        if (!element || !this.canShoot()) return;
        element.pause();
        try {
            await this.stitcher.capture(element);
        } finally {
            await element.play().catch(() => undefined);
        }
    }

    async switchCamera(): Promise<void> {
        const next = this.camera.nextDeviceId();
        if (!next) return;
        const stream = await this.camera.open(next);
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
