import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { StitcherService } from '../../core/services/stitcher-service';

@Component({
    selector: 'app-busy-veil',
    templateUrl: './busy-veil.html',
    styleUrl: './busy-veil.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
    host: { '[class.visible]': 'visible()' },
})
export class BusyVeil {
    private readonly stitcher = inject(StitcherService);

    readonly visible = computed(
        () => this.stitcher.busy() || this.stitcher.composing() || !this.stitcher.ready(),
    );
    readonly label = computed(() => {
        if (!this.stitcher.ready()) return 'starting';
        const progress = this.stitcher.progress();
        const status = this.stitcher.status();
        return progress >= 0 && progress < 1 ? `${status} ${Math.round(progress * 100)}%` : status;
    });
}
