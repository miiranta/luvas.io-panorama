import {
    ChangeDetectionStrategy,
    Component,
    ElementRef,
    computed,
    effect,
    inject,
    output,
    viewChild,
} from '@angular/core';
import { StitcherService } from '../../core/services/stitcher-service';
import { ConnectionPayload } from '../../core/models/reports';

@Component({
    selector: 'app-match-dialog',
    templateUrl: './match-dialog.html',
    styleUrl: './match-dialog.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MatchDialog {
    private readonly stitcher = inject(StitcherService);
    private readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('canvas');

    readonly close = output<void>();

    readonly connection = this.stitcher.connection;
    readonly inliers = computed(() => this.connection()?.report.inliers ?? 0);
    readonly error = computed(() => this.connection()?.report.meanError ?? 0);
    readonly ratio = computed(() => (this.connection()?.report.inlierRatio ?? 0) * 100);
    readonly verified = computed(() => this.connection()?.report.verified ?? false);

    constructor() {
        effect(() => {
            const payload = this.connection();
            const element = this.canvas()?.nativeElement;
            if (element && payload) this.draw(element, payload);
        });
    }

    private draw(element: HTMLCanvasElement, payload: ConnectionPayload): void {
        const gap = 10;
        element.width = payload.trainWidth + gap + payload.width;
        element.height = Math.max(payload.height, payload.trainHeight);
        const context = element.getContext('2d');
        if (!context) return;
        context.fillStyle = '#17102e';
        context.fillRect(0, 0, element.width, element.height);
        const offset = payload.trainWidth + gap;
        this.paint(context, payload.trainImage, payload.trainWidth, payload.trainHeight, 0);
        this.paint(context, payload.queryImage, payload.width, payload.height, offset);
        context.lineWidth = 1.2;
        for (const match of payload.matches) {
            const q = payload.queryKeypoints[match.queryIndex];
            const t = payload.trainKeypoints[match.trainIndex];
            if (!q || !t) continue;
            if (match.inlier) {
                context.strokeStyle = 'rgba(255, 201, 60, 0.92)';
                context.setLineDash([]);
            } else if (match.accepted) {
                context.strokeStyle = 'rgba(255, 122, 28, 0.85)';
                context.setLineDash([]);
            } else {
                context.strokeStyle = 'rgba(255, 93, 143, 0.45)';
                context.setLineDash([4, 5]);
            }
            context.beginPath();
            context.moveTo(t.x, t.y);
            context.lineTo(q.x + offset, q.y);
            context.stroke();
        }
        context.setLineDash([]);

        context.font = '700 15px ui-monospace, monospace';
        const caption = (text: string, x: number) => {
            const metrics = context.measureText(text);
            context.fillStyle = 'rgba(13, 8, 32, 0.85)';
            context.fillRect(x, 8, metrics.width + 14, 24);
            context.fillStyle = '#ffc93c';
            context.fillText(text, x + 7, 25);
        };
        caption(`panorama ${payload.trainLabel}`, 8);
        caption(`new ${payload.queryLabel}`, offset + 8);

        context.strokeStyle = 'rgba(255, 159, 28, 0.85)';
        for (const [points, shift] of [
            [payload.trainKeypoints, 0],
            [payload.queryKeypoints, offset],
        ] as const) {
            for (const point of points) {
                const radius = 4 * point.scale;
                context.beginPath();
                context.arc(point.x + shift, point.y, radius, 0, Math.PI * 2);
                context.stroke();
                context.beginPath();
                context.moveTo(point.x + shift, point.y);
                context.lineTo(
                    point.x + shift + Math.cos(point.orientation) * radius * 2,
                    point.y + Math.sin(point.orientation) * radius * 2,
                );
                context.stroke();
            }
        }
    }

    private paint(
        context: CanvasRenderingContext2D,
        buffer: ArrayBuffer,
        width: number,
        height: number,
        x: number,
    ): void {
        context.putImageData(
            new ImageData(new Uint8ClampedArray(buffer.slice(0)), width, height),
            x,
            0,
        );
    }
}
