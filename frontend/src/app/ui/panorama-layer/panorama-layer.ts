import {
    ChangeDetectionStrategy,
    Component,
    ElementRef,
    computed,
    effect,
    inject,
    input,
    output,
    signal,
    viewChild,
} from '@angular/core';
import { StitcherService } from '../../core/services/stitcher.service';

@Component({
    selector: 'app-panorama-layer',
    templateUrl: './panorama-layer.html',
    styleUrl: './panorama-layer.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
    host: { '[class.expanded]': 'expanded()' },
})
export class PanoramaLayer {
    private readonly stitcher = inject(StitcherService);
    private readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('canvas');

    readonly expanded = input(false);
    readonly toggle = output<void>();

    readonly mosaic = this.stitcher.mosaic;
    readonly saving = signal(false);
    readonly composing = this.stitcher.composing;
    readonly canExport = computed(() => this.stitcher.exportReady() && !this.saving());
    readonly size = computed(() => {
        const mosaic = this.mosaic();
        if (!mosaic) return '';
        return `${mosaic.width}×${mosaic.height} · ${mosaic.surface} · ${mosaic.frames} photos`;
    });

    constructor() {
        effect(() => {
            const mosaic = this.mosaic();
            const element = this.canvas()?.nativeElement;
            if (!element || !mosaic) return;
            element.width = mosaic.width;
            element.height = mosaic.height;
            const context = element.getContext('2d');
            if (!context) return;
            context.putImageData(
                new ImageData(
                    new Uint8ClampedArray(mosaic.pixels.slice(0)),
                    mosaic.width,
                    mosaic.height,
                ),
                0,
                0,
            );
        });
    }

    dismiss(event: Event): void {
        event.stopPropagation();
        this.toggle.emit();
    }

    async save(event: Event): Promise<void> {
        event.stopPropagation();
        if (!this.canExport()) return;
        this.saving.set(true);
        try {
            const blob = await this.stitcher.exportPanorama();
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = `panorama-${Date.now()}.png`;
            anchor.click();
            URL.revokeObjectURL(url);
        } finally {
            this.saving.set(false);
        }
    }
}
