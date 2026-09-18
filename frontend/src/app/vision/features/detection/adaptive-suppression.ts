import { Keypoint } from './keypoint';

function coveringSuppression(
    sorted: readonly Keypoint[],
    width: number,
    height: number,
    radius: number,
    limit: number,
): Keypoint[] {
    const cell = radius / Math.SQRT2;
    const reach = Math.ceil(radius / cell);
    const columns = Math.max(1, Math.ceil(width / cell));
    const rows = Math.max(1, Math.ceil(height / cell));
    const occupied = new Int32Array(columns * rows).fill(-1);
    const radiusSquared = radius * radius;
    const kept: Keypoint[] = [];
    for (let index = 0; index < sorted.length && kept.length < limit; index++) {
        const point = sorted[index];
        const column = Math.min(columns - 1, Math.floor(point.x / cell));
        const row = Math.min(rows - 1, Math.floor(point.y / cell));
        if (occupied[row * columns + column] >= 0) continue;
        let blocked = false;
        const rowEnd = Math.min(rows - 1, row + reach);
        const columnEnd = Math.min(columns - 1, column + reach);
        for (let r = Math.max(0, row - reach); r <= rowEnd && !blocked; r++) {
            for (let c = Math.max(0, column - reach); c <= columnEnd; c++) {
                const other = occupied[r * columns + c];
                if (other < 0) continue;
                const dx = sorted[other].x - point.x;
                const dy = sorted[other].y - point.y;
                if (dx * dx + dy * dy < radiusSquared) {
                    blocked = true;
                    break;
                }
            }
        }
        if (blocked) continue;
        occupied[row * columns + column] = index;
        kept.push(point);
    }
    return kept;
}

export function adaptiveSuppression(
    points: Keypoint[],
    limit: number,
    width: number,
    height: number,
): Keypoint[] {
    if (points.length <= limit) return points;
    const sorted = points.slice().sort((a, b) => b.response - a.response);
    const target = limit - Math.max(1, Math.round(limit * 0.1));
    let low = 1;
    let high = Math.ceil(Math.hypot(width, height));
    let best: Keypoint[] | null = null;
    while (low <= high) {
        const radius = (low + high) >> 1;
        const kept = coveringSuppression(sorted, width, height, radius, limit);
        if (kept.length >= target) {
            best = kept;
            low = radius + 1;
        } else {
            high = radius - 1;
        }
    }
    return best ?? sorted.slice(0, limit);
}
