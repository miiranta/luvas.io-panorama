const weightTables = new Map<number, Float64Array>();

function gaussianWeights(radius: number): Float64Array {
    const cached = weightTables.get(radius);
    if (cached) return cached;
    const sigma = radius / 2 || 1;
    const denom = 2 * sigma * sigma;
    const side = radius * 2 + 1;
    const table = new Float64Array(side * side);
    for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
            const r2 = dx * dx + dy * dy;
            table[(dy + radius) * side + dx + radius] =
                r2 > radius * radius ? 0 : Math.exp(-r2 / denom);
        }
    }
    weightTables.set(radius, table);
    return table;
}

export function dominantOrientation(
    gradient: Float32Array,
    width: number,
    height: number,
    cx: number,
    cy: number,
    radius: number,
): number {
    const bins = 36;
    const hist = new Float64Array(bins);
    const x0 = Math.max(1, cx - radius);
    const x1 = Math.min(width - 2, cx + radius);
    const y0 = Math.max(1, cy - radius);
    const y1 = Math.min(height - 2, cy + radius);
    const table = gaussianWeights(radius);
    const side = radius * 2 + 1;
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            const falloff = table[(y - cy + radius) * side + x - cx + radius];
            if (falloff === 0) continue;
            const i = (y * width + x) * 4;
            const weight = gradient[i + 2] * falloff;
            let angle = Math.atan2(gradient[i + 1], gradient[i]);
            if (angle < 0) angle += Math.PI * 2;
            const bin = Math.min(bins - 1, Math.floor((angle / (Math.PI * 2)) * bins));
            hist[bin] += weight;
        }
    }
    let best = 0;
    for (let i = 1; i < bins; i++) if (hist[i] > hist[best]) best = i;
    const prev = hist[(best - 1 + bins) % bins];
    const next = hist[(best + 1) % bins];
    const denomP = prev - 2 * hist[best] + next;
    const offset = Math.abs(denomP) < 1e-12 ? 0 : (0.5 * (prev - next)) / denomP;
    return (((best + offset + 0.5) / bins) * Math.PI * 2) % (Math.PI * 2);
}
