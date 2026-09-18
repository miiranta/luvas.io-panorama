import { ComposeParams } from '../../core/models/params';
import { WarpBackend, cpuWarpBackend } from '../acceleration/warp-backend';
import { ColorImage } from '../imaging/image';
import { Mat3 } from '../math/matrix3';
import { CanvasGeometry, alignDown, alignUp, computeFootprint } from './canvas-geometry';
import { WarpTile } from './warp-tile';

export class Warper {
    constructor(
        private readonly geometry: CanvasGeometry,
        private readonly params: ComposeParams,
        private readonly backend: WarpBackend = cpuWarpBackend,
    ) {}

    warp(rotation: Mat3, source: ColorImage, sourceFocal: number, gain: number): WarpTile | null {
        const { geometry, params } = this;
        const footprint = computeFootprint(
            geometry,
            rotation,
            source.width,
            source.height,
            sourceFocal,
        );
        if (!footprint.valid) return null;
        const pad = params.blend === 'multiband' ? Math.ceil(params.featherWidth / 2) + 4 : 2;
        const wraps = geometry.surface !== 'planar';
        const aligned = params.blend === 'multiband';
        const rawU0 = wraps ? footprint.u0 - pad : Math.max(0, footprint.u0 - pad);
        const rawU1 = wraps ? footprint.u1 + pad : Math.min(geometry.width - 1, footprint.u1 + pad);
        const rawV0 = Math.max(0, footprint.v0 - pad);
        const rawV1 = Math.min(geometry.height - 1, footprint.v1 + pad);
        const u0 = aligned ? alignDown(rawU0) : rawU0;
        const v0 = aligned ? Math.max(0, alignDown(rawV0)) : rawV0;
        const u1 = aligned ? alignUp(rawU1 + 1) - 1 : rawU1;
        const v1 = aligned ? Math.min(geometry.height - 1, alignUp(rawV1 + 1) - 1) : rawV1;
        const width = u1 - u0 + 1;
        const height = v1 - v0 + 1;
        if (width <= 0 || height <= 0 || width > geometry.width * 1.2) return null;
        const request = {
            geometry,
            rotation,
            source,
            focal: sourceFocal,
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
