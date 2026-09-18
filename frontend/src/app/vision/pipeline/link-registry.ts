import { GraphPayload } from '../../core/models/reports';
import { GraphEdge, PoseGraph } from '../registration/alignment/pose-graph';
import { opticalAxis, yawPitchDegrees } from '../foundation/math/rotation';
import { Keyframe } from './keyframe';
import { PairLink } from './pair-link';

const EMPTY_GRAPH: GraphPayload = { nodes: [], edges: [], order: [], reference: -1, components: 0 };

export class LinkRegistry {
    private links: PairLink[] = [];

    get all(): readonly PairLink[] {
        return this.links;
    }

    get verified(): PairLink[] {
        return this.links.filter((link) => link.verified);
    }

    add(...links: PairLink[]): void {
        this.links.push(...links);
    }

    replace(links: PairLink[]): void {
        this.links = links;
    }

    clear(): void {
        this.links = [];
    }

    between(a: number, b: number): PairLink | undefined {
        return this.links.find(
            (link) => (link.a === a && link.b === b) || (link.a === b && link.b === a),
        );
    }

    poseGraph(frames: readonly Keyframe[]): PoseGraph {
        const indexOf = new Map(frames.map((frame, index) => [frame.id, index]));
        const edges: GraphEdge[] = [];
        for (const link of this.links) {
            const a = indexOf.get(link.a);
            const b = indexOf.get(link.b);
            if (a === undefined || b === undefined) continue;
            edges.push({
                a,
                b,
                matches: link.matches,
                inliers: link.inliers,
                meanError: link.meanError,
                verified: link.verified,
                inTree: false,
            });
        }
        return new PoseGraph(frames.length, edges);
    }

    compositionOrder(frames: readonly Keyframe[]): number[] {
        const active = frames.filter((frame) => !frame.rejected);
        const ordered = this.panoramaOrder(frames, this.poseGraph(frames));
        for (const frame of active) if (!ordered.includes(frame.id)) ordered.push(frame.id);
        return ordered;
    }

    payload(frames: readonly Keyframe[]): GraphPayload {
        if (frames.length === 0) return EMPTY_GRAPH;
        const graph = this.poseGraph(frames);
        return {
            nodes: frames.map((frame, index) => ({
                id: frame.id,
                label: frame.label,
                ...yawPitchDegrees(frame.rotation),
                keypoints: frame.keypoints.length,
                rejected: frame.rejected,
                inMainComponent: graph.inMainComponent(index),
            })),
            edges: graph.edges.map((edge) => ({
                ...edge,
                a: frames[edge.a].id,
                b: frames[edge.b].id,
            })),
            order: this.panoramaOrder(frames, graph),
            reference: frames[graph.reference]?.id ?? -1,
            components: graph.componentCount,
        };
    }

    private panoramaOrder(frames: readonly Keyframe[], graph: PoseGraph): number[] {
        if (graph.traversal.length === 0) return [];
        const yaw = (frame: Keyframe) => {
            const [x, , z] = opticalAxis(frame.rotation);
            return Math.atan2(x, z);
        };
        return frames
            .filter((frame, index) => graph.inMainComponent(index) && !frame.rejected)
            .sort((a, b) => yaw(a) - yaw(b))
            .map((frame) => frame.id);
    }
}
