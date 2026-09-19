import { SurfaceKind } from '../../../core/models/params';
import { Mat3 } from '../../foundation/math/matrix3';
import { angularSpan, createCanvasGeometry } from './canvas-geometry';
import { FootprintRequest, unionFootprints } from './footprint';

const SURFACES: readonly SurfaceKind[] = ['planar', 'cylindrical', 'spherical'];
const PROBE_WIDTH = 1024;

function coverage(surface: SurfaceKind): { horizontal: number; vertical: number } {
    const geometry = createCanvasGeometry(surface, PROBE_WIDTH, 1);
    return angularSpan(geometry, { u0: 0, v0: 0, u1: geometry.width - 1, v1: geometry.height - 1 });
}

export function chooseSurface(frames: readonly FootprintRequest[], orientation: Mat3): SurfaceKind {
    const probe = createCanvasGeometry('spherical', PROBE_WIDTH, 1, orientation);
    const box = unionFootprints(probe, frames);
    if (!box) return 'planar';
    const extent = angularSpan(probe, box);
    return (
        SURFACES.find((surface) => {
            const limit = coverage(surface);
            return extent.horizontal <= limit.horizontal && extent.vertical <= limit.vertical;
        }) ?? 'spherical'
    );
}
