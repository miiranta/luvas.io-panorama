import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { StitcherService } from '../../core/services/stitcher.service';

@Component({
    selector: 'app-busy-veil',
    templateUrl: './busy-veil.html',
    styleUrl: './busy-veil.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
    host: { '[class.visible]': 'visible()' },
})
export class BusyVeil {
    private readonly stitcher = inject(StitcherService);

    readonly visible = computed(() => this.stitcher.busy() || !this.stitcher.ready());
    readonly label = computed(() => (this.stitcher.ready() ? this.stitcher.status() : 'starting'));
}
