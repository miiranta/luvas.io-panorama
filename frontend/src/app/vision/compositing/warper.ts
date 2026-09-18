import { ComposeParams } from '../../core/models/params';
import { ColorImage, sampleBilinear } from '../imaging/image';
import { Mat3 } from '../math/matrix3';
import { CanvasGeometry, canvasRay, computeFootprint } from './canvas-geometry';
import { WarpTile } from './warp-tile';

export class Warper {
    constructor(
        private readonly geometry: CanvasGeometry,
        private readonly params: ComposeParams,
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
        const u0 = wraps ? footprint.u0 - pad : Math.max(0, footprint.u0 - pad);
        const u1 = wraps ? footprint.u1 + pad : Math.min(geometry.width - 1, footprint.u1 + pad);
        const v0 = Math.max(0, footprint.v0 - pad);
        const v1 = Math.min(geometry.height - 1, footprint.v1 + pad);
        const width = u1 - u0 + 1;
        const height = v1 - v0 + 1;
        if (width <= 0 || height <= 0 || width > geometry.width * 1.2) return null;
        const color = new Float32Array(width * height * 3);
        const mask = new Float32Array(width * height);
        const ray = new Float64Array(3);
        const sample = new Float32Array(3);
        const cx = source.width / 2;
        const cy = source.height / 2;
        const feather = Math.max(1, params.featherWidth);
        let pixels = 0;
        for (let y = 0; y < height; y++) {
            const cv = v0 + y;
            for (let x = 0; x < width; x++) {
                const raw = u0 + x;
                if (!wraps && (raw < 0 || raw >= geometry.width)) continue;
                const cu = ((raw % geometry.width) + geometry.width) % geometry.width;
                canvasRay(geometry, cu + 0.5, cv + 0.5, ray);
                const camX = rotation[0] * ray[0] + rotation[1] * ray[1] + rotation[2] * ray[2];
                const camY = rotation[3] * ray[0] + rotation[4] * ray[1] + rotation[5] * ray[2];
                const camZ = rotation[6] * ray[0] + rotation[7] * ray[1] + rotation[8] * ray[2];
                if (camZ <= 1e-6) continue;
                const px = (sourceFocal * camX) / camZ + cx;
                const py = (sourceFocal * camY) / camZ + cy;
                if (px < 0 || py < 0 || px > source.width - 1 || py > source.height - 1) continue;
                if (!sampleBilinear(source.data, source.width, source.height, px, py, sample))
                    continue;
                const t = y * width + x;
                color[t * 3] = Math.min(255, sample[0] * gain);
                color[t * 3 + 1] = Math.min(255, sample[1] * gain);
                color[t * 3 + 2] = Math.min(255, sample[2] * gain);
                const edge = Math.min(
                    Math.min(px, source.width - 1 - px),
                    Math.min(py, source.height - 1 - py),
                );
                mask[t] = Math.min(1, (edge + 0.5) / feather);
                pixels++;
            }
        }
        if (pixels === 0) return null;
        return { u0, v0, width, height, color, mask, pixels };
    }
}
