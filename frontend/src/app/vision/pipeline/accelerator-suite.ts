import { PipelineParams } from '../../core/models/params';
import { BackendSelector } from '../acceleration/backend-selector';
import { BlurBackend, createBlurSelector } from '../acceleration/blur-backend';
import { DetectBackend, createDetectSelector } from '../acceleration/detect-backend';
import { MatchBackend, createMatchSelector } from '../acceleration/match-backend';
import { WarpBackend, createWarpSelector } from '../acceleration/warp-backend';
import { CornerDetector } from '../features/corner-detector';
import { DescriptorMatcher } from '../features/descriptor-matcher';

export interface AcceleratorLabels {
    blurBackend: string;
    matchBackend: string;
    detectBackend: string;
    warpBackend: string;
}

export class AcceleratorSuite {
    private readonly blurSelector: BackendSelector<BlurBackend> = createBlurSelector();
    private readonly matchSelector: BackendSelector<MatchBackend> = createMatchSelector();
    private readonly warpSelector: BackendSelector<WarpBackend> = createWarpSelector();
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

    labels(): AcceleratorLabels {
        return {
            blurBackend: this.blurSelector.describe(this.enabled),
            matchBackend: this.matchSelector.describe(this.enabled),
            detectBackend: this.detectSelector.describe(this.enabled),
            warpBackend: this.warpSelector.describe(this.enabled),
        };
    }
}
