import {
    ChangeDetectionStrategy,
    Component,
    ElementRef,
    computed,
    effect,
    inject,
    viewChild,
} from '@angular/core';
import { StitcherService } from '../../core/services/stitcher-service';
import { PreviewVector } from '../../core/models/reports';

interface Overlay {
    width: number;
    height: number;
    vectors: PreviewVector[];
    inliers: number;
    error: number;
    verified: boolean;
    live: boolean;
    reference: string;
}

@Component({
    selector: 'app-tracks-layer',
    templateUrl: './tracks-layer.html',
    styleUrl: './tracks-layer.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
    host: { '(window:resize)': 'redraw()' },
})
export class TracksLayer {
    private readonly stitcher = inject(StitcherService);
    private readonly host = inject(ElementRef<HTMLElement>);
    private readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('canvas');

    readonly overlay = computed<Overlay | null>(() => {
        const live = this.stitcher.preview();
        if (live) {
            return {
                width: live.width,
                height: live.height,
                vectors: live.vectors,
                inliers: live.inliers,
                error: live.meanError,
                verified: live.verified,
                live: true,
                reference: live.referenceLabel,
            };
        }
        const shot = this.stitcher.connection();
        if (!shot) return null;
        const vectors: PreviewVector[] = [];
        for (const match of shot.matches) {
            if (!match.accepted) continue;
            const from = shot.trainKeypoints[match.trainIndex];
            const to = shot.queryKeypoints[match.queryIndex];
            if (!from || !to) continue;
            vectors.push({ fx: from.x, fy: from.y, tx: to.x, ty: to.y, inlier: match.inlier });
        }
        return {
            width: shot.width,
            height: shot.height,
            vectors,
            inliers: shot.report.inliers,
            error: shot.report.meanError,
            verified: shot.report.verified,
            live: false,
            reference: shot.trainLabel,
        };
    });

    constructor() {
        effect(() => {
            const overlay = this.overlay();
            if (overlay) this.paint(overlay);
            else this.clear();
        });
    }

    redraw(): void {
        const overlay = this.overlay();
        if (overlay) this.paint(overlay);
    }

    private clear(): void {
        const element = this.canvas()?.nativeElement;
        const context = element?.getContext('2d');
        if (element && context) context.clearRect(0, 0, element.width, element.height);
    }

    private paint(overlay: Overlay): void {
        const element = this.canvas()?.nativeElement;
        if (!element) return;
        const box = (this.host.nativeElement as HTMLElement).getBoundingClientRect();
        if (box.width < 2 || box.height < 2) return;
        const ratio = Math.min(2, window.devicePixelRatio || 1);
        element.width = Math.round(box.width * ratio);
        element.height = Math.round(box.height * ratio);
        const context = element.getContext('2d', { desynchronized: true });
        if (!context) return;
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, box.width, box.height);

        const scale = Math.max(box.width / overlay.width, box.height / overlay.height);
        const offsetX = (box.width - overlay.width * scale) / 2;
        const offsetY = (box.height - overlay.height * scale) / 2;
        const mapX = (x: number) => offsetX + x * scale;
        const mapY = (y: number) => offsetY + y * scale;

        context.lineWidth = 2;
        for (const vector of overlay.vectors) {
            context.strokeStyle = vector.inlier
                ? 'rgba(255, 201, 60, 0.85)'
                : 'rgba(255, 122, 28, 0.45)';
            context.beginPath();
            context.moveTo(mapX(vector.fx), mapY(vector.fy));
            context.lineTo(mapX(vector.tx), mapY(vector.ty));
            context.stroke();
        }

        const dot = (x: number, y: number, radius: number, fill: string) => {
            context.beginPath();
            context.arc(x, y, radius, 0, Math.PI * 2);
            context.fillStyle = fill;
            context.fill();
            context.lineWidth = 2;
            context.strokeStyle = 'rgba(13, 8, 32, 0.9)';
            context.stroke();
        };
        for (const vector of overlay.vectors) {
            if (!vector.inlier) continue;
            dot(mapX(vector.fx), mapY(vector.fy), 3.4, 'rgba(255, 93, 143, 0.95)');
        }
        for (const vector of overlay.vectors) {
            if (!vector.inlier) continue;
            dot(mapX(vector.tx), mapY(vector.ty), 4.2, 'rgba(255, 201, 60, 0.95)');
        }
    }
}
