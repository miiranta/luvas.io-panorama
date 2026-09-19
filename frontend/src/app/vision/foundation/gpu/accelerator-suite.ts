import { PipelineParams } from '../../../core/models/params';
import { BackendSelector } from './backend-selector';
import { BlurBackend, createBlurSelector } from '../../compositing/blending/blur-backend';
import { DetectBackend, createDetectSelector } from '../../features/detection/detect-backend';
import { MatchBackend, createMatchSelector } from '../../features/matching/match-backend';
import { WarpBackend, createWarpSelector } from '../../compositing/warping/warp-backend';
import { CpuMosaic } from '../../compositing/blending/cpu-mosaic';
import { MosaicMaker, createMosaicSelector } from '../../compositing/blending/mosaic-backend';
import { MosaicFactory } from '../../compositing/blending/mosaic-surface';
import { CornerDetector } from '../../features/detection/corner-detector';
import { DescriptorMatcher } from '../../features/matching/descriptor-matcher';

export interface AcceleratorLabels {
    blurBackend: string;
    matchBackend: string;
    detectBackend: string;
    warpBackend: string;
    mosaicBackend: string;
}

export class AcceleratorSuite {
    private readonly blurSelector: BackendSelector<BlurBackend> = createBlurSelector();
    private readonly matchSelector: BackendSelector<MatchBackend> = createMatchSelector();
    private readonly warpSelector: BackendSelector<WarpBackend> = createWarpSelector();
    private readonly mosaicSelector: BackendSelector<MosaicMaker> = createMosaicSelector();
    private readonly detectSelector: BackendSelector<DetectBackend>;

    constructor(private readonly params: () => PipelineParams) {
        this.detectSelector = createDetectSelector(() => this.params().detect);
    }

    private get enabled(): boolean {
        return this.params().compose.gpu;
    }

    blur(): BlurBackend {
        return this.blurSelector.select(this.enabled);
    }

    detector(): CornerDetector {
        return new CornerDetector(this.detectSelector.select(this.enabled));
    }

    matcher(): DescriptorMatcher {
        return new DescriptorMatcher(this.matchSelector.select(this.enabled));
    }

    warper(): WarpBackend {
        return this.warpSelector.select(this.enabled);
    }

    mosaics(): MosaicFactory {
        const maker = this.mosaicSelector.select(this.enabled);
        return (width, height, bands, view) =>
            maker.create(width, height, bands, view) ?? new CpuMosaic(width, height, bands, view);
    }

    warmup(): void {
        if (!this.enabled) return;
        this.blurSelector.select(true);
        this.matchSelector.select(true);
        this.detectSelector.select(true);
        this.warpSelector.select(true);
        this.mosaicSelector.select(true);
    }

    labels(): AcceleratorLabels {
        return {
            blurBackend: this.blurSelector.describe(this.enabled),
            matchBackend: this.matchSelector.describe(this.enabled),
            detectBackend: this.detectSelector.describe(this.enabled),
            warpBackend: this.warpSelector.describe(this.enabled),
            mosaicBackend: this.mosaicSelector.describe(this.enabled),
        };
    }
}
