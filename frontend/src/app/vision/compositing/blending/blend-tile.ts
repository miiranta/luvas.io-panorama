import { BlendKind, ComposeParams } from '../../../core/models/params';
import { WarpTile } from '../warping/warp-tile';
import { BlurBackend } from './blur-backend';
import { CompositeMode, MosaicSurface } from './mosaic-surface';

export function compositeMode(params: ComposeParams): CompositeMode {
    return params.seam ? 'over' : 'add';
}

export function blendTile(
    mosaic: MosaicSurface,
    tile: WarpTile,
    blend: BlendKind,
    blur: BlurBackend,
    mode: CompositeMode,
): void {
    if (blend === 'multiband') {
        mosaic.addPyramidBands(tile, blur, mode);
        return;
    }
    if (blend === 'average') {
        for (let i = 0; i < tile.mask.length; i++) tile.mask[i] = tile.mask[i] > 0 ? 1 : 0;
    }
    mosaic.addFlat(tile, mode);
}
