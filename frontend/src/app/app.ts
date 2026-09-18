import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { StitcherService } from './core/services/stitcher-service';
import { BusyVeil } from './ui/busy-veil/busy-veil';
import { CameraStage } from './ui/camera-stage/camera-stage';
import { ConfirmDialog } from './ui/confirm-dialog/confirm-dialog';
import { InsightsSheet } from './ui/insights-sheet/insights-sheet';
import { MatchDialog } from './ui/match-dialog/match-dialog';
import { PanoramaLayer } from './ui/panorama-layer/panorama-layer';
import { SettingsSheet } from './ui/settings-sheet/settings-sheet';
import { TracksLayer } from './ui/tracks-layer/tracks-layer';

type Sheet = 'none' | 'settings' | 'insights' | 'match';

@Component({
    selector: 'app-root',
    imports: [
        BusyVeil,
        CameraStage,
        ConfirmDialog,
        InsightsSheet,
        MatchDialog,
        PanoramaLayer,
        SettingsSheet,
        TracksLayer,
    ],
    templateUrl: './app.html',
    styleUrl: './app.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App implements OnInit {
    private readonly stitcher = inject(StitcherService);

    readonly sheet = signal<Sheet>('none');
    readonly minimapExpanded = signal(false);
    readonly askingReset = signal(false);
    readonly frames = this.stitcher.acceptedFrames;

    ngOnInit(): void {
        this.stitcher.start();
    }

    openSheet(sheet: Sheet): void {
        this.sheet.set(sheet);
    }

    toggleMinimap(): void {
        this.minimapExpanded.update((expanded) => !expanded);
    }

    confirmReset(): void {
        this.askingReset.set(false);
        this.stitcher.reset();
    }
}
