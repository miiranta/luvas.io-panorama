import { ComposeParams } from '../../core/models/params';
import { WarpBackend, cpuWarpBackend } from '../acceleration/warp-backend';
import { ColorImage } from '../imaging/image';
import { Mat3 } from '../math/matrix3';
import {
    CanvasBox,
    CanvasGeometry,
    alignDown,
    alignUp,
    clipFootprint,
    computeFootprint,
} from './canvas-geometry';
import { WarpTile } from './warp-tile';

export class Warper {
    constructor(
        private readonly geometry: CanvasGeometry,
        private readonly params: ComposeParams,
        private readonly backend: WarpBackend = cpuWarpBackend,
    ) {}

    warp(
        rotation: Mat3,
        source: ColorImage,
        sourceFocal: number,
        gain: number,
        distortion = 0,
        vignetting = 0,
        clip: CanvasBox | null = null,
    ): WarpTile | null {
        const { geometry, params } = this;
        const footprint = computeFootprint(
            geometry,
            rotation,
            source.width,
            source.height,
            sourceFocal,
            distortion,
        );
        if (!footprint.valid) return null;
        const pad = params.blend === 'multiband' ? Math.ceil(params.featherWidth / 2) + 4 : 2;
        const wraps = geometry.surface !== 'planar';
        const aligned = params.blend === 'multiband';
        const padded = {
            u0: wraps ? footprint.u0 - pad : Math.max(0, footprint.u0 - pad),
            u1: wraps ? footprint.u1 + pad : Math.min(geometry.width - 1, footprint.u1 + pad),
            v0: Math.max(0, footprint.v0 - pad),
            v1: Math.min(geometry.height - 1, footprint.v1 + pad),
        };
        const bounds = clip ? clipFootprint(geometry, padded, clip) : padded;
        if (!bounds) return null;
        const u0 = aligned ? alignDown(bounds.u0) : bounds.u0;
        const v0 = aligned ? Math.max(0, alignDown(bounds.v0)) : bounds.v0;
        const u1 = aligned ? alignUp(bounds.u1 + 1) - 1 : bounds.u1;
        const v1 = aligned ? Math.min(geometry.height - 1, alignUp(bounds.v1 + 1) - 1) : bounds.v1;
        const width = u1 - u0 + 1;
        const height = v1 - v0 + 1;
        if (width <= 0 || height <= 0 || width > geometry.width * 1.2) return null;
        const request = {
            geometry,
            rotation,
            source,
            focal: sourceFocal,
            distortion,
            vignetting,
            gain,
            feather: Math.max(1, params.featherWidth),
            u0,
            v0,
            width,
            height,
        };
        const result = this.backend.warp(request) ?? cpuWarpBackend.warp(request);
        if (!result || result.pixels === 0) return null;
        return {
            u0,
            v0,
            width,
            height,
            color: result.color,
            mask: result.mask,
            pixels: result.pixels,
        };
    }
}
