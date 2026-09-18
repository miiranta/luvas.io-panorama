import { ChangeDetectionStrategy, Component, computed, inject, output } from '@angular/core';
import { StitcherService } from '../../core/services/stitcher.service';

interface NodeDot {
    id: number;
    label: string;
    x: number;
    y: number;
    rejected: boolean;
    reference: boolean;
}

interface EdgeLine {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    width: number;
    inTree: boolean;
}

@Component({
    selector: 'app-insights-sheet',
    templateUrl: './insights-sheet.html',
    styleUrl: './insights-sheet.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InsightsSheet {
    private readonly stitcher = inject(StitcherService);

    readonly close = output<void>();
    readonly graph = this.stitcher.graph;
    readonly mosaic = this.stitcher.mosaic;
    readonly last = this.stitcher.lastReport;

    readonly nodes = computed<NodeDot[]>(() => {
        const nodes = this.graph().nodes;
        const reference = this.graph().reference;
        return nodes.map((node, index) => {
            const angle = (index / Math.max(1, nodes.length)) * Math.PI * 2 - Math.PI / 2;
            return {
                id: node.id,
                label: node.label,
                x: 50 + Math.cos(angle) * 36,
                y: 50 + Math.sin(angle) * 36,
                rejected: node.rejected || !node.inMainComponent,
                reference: node.id === reference,
            };
        });
    });

    readonly edges = computed<EdgeLine[]>(() => {
        const points = new Map(this.nodes().map((node) => [node.id, node]));
        const peak = Math.max(1, ...this.graph().edges.map((edge) => edge.inliers));
        return this.graph()
            .edges.filter((edge) => edge.inliers > 0)
            .flatMap((edge) => {
                const a = points.get(edge.a);
                const b = points.get(edge.b);
                if (!a || !b) return [];
                return [
                    {
                        x1: a.x,
                        y1: a.y,
                        x2: b.x,
                        y2: b.y,
                        width: 0.35 + (edge.inliers / peak) * 1.6,
                        inTree: edge.inTree,
                    },
                ];
            });
    });

    readonly order = computed(() => {
        const labels = new Map(this.graph().nodes.map((node) => [node.id, node.label]));
        return this.graph()
            .order.map((id) => labels.get(id) ?? `#${id}`)
            .join(' → ');
    });

    readonly dropped = computed(() =>
        this.graph()
            .nodes.filter((node) => node.rejected || !node.inMainComponent)
            .map((node) => node.label)
            .join(', '),
    );

    readonly timings = computed(() => {
        const report = this.last();
        if (!report) return null;
        const t = report.timings;
        return [
            { name: 'detectar', value: t.detect + t.describe },
            { name: 'casar', value: t.match },
            { name: 'modelo', value: t.model },
            { name: 'bundle', value: t.bundle },
            { name: 'compor', value: t.compose },
        ];
    });

    readonly fill = computed(() => this.mosaic()?.fillPercent ?? null);

    readonly ghosts = computed(() => {
        const report = this.last();
        if (!report || report.overlapPixels === 0) return null;
        return (report.inconsistentPixels / report.overlapPixels) * 100;
    });

    resolve(): void {
        this.stitcher.resolveFromScratch();
    }
}
