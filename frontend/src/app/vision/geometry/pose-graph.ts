export interface GraphEdge {
    a: number;
    b: number;
    matches: number;
    inliers: number;
    meanError: number;
    verified: boolean;
    inTree: boolean;
}

export function brownLoweVerified(inliers: number, matches: number): boolean {
    return inliers > 5.9 + 0.22 * matches;
}

function maximumSpanningTree(nodeCount: number, edges: GraphEdge[]): GraphEdge[] {
    const parent = new Int32Array(nodeCount);
    for (let i = 0; i < nodeCount; i++) parent[i] = i;
    const find = (x: number): number => {
        let root = x;
        while (parent[root] !== root) root = parent[root];
        let cursor = x;
        while (parent[cursor] !== root) {
            const next = parent[cursor];
            parent[cursor] = root;
            cursor = next;
        }
        return root;
    };
    const sorted = edges
        .filter((e) => e.verified)
        .slice()
        .sort((a, b) => b.inliers - a.inliers);
    const tree: GraphEdge[] = [];
    for (const edge of sorted) {
        const ra = find(edge.a);
        const rb = find(edge.b);
        if (ra === rb) continue;
        parent[ra] = rb;
        edge.inTree = true;
        tree.push(edge);
    }
    return tree;
}

function connectedComponents(nodeCount: number, edges: readonly GraphEdge[]): number[] {
    const component = new Array<number>(nodeCount).fill(-1);
    const adjacency: number[][] = Array.from({ length: nodeCount }, () => []);
    for (const edge of edges) {
        if (!edge.verified) continue;
        adjacency[edge.a].push(edge.b);
        adjacency[edge.b].push(edge.a);
    }
    let current = 0;
    for (let start = 0; start < nodeCount; start++) {
        if (component[start] >= 0) continue;
        const queue = [start];
        component[start] = current;
        while (queue.length > 0) {
            const node = queue.pop() as number;
            for (const next of adjacency[node]) {
                if (component[next] >= 0) continue;
                component[next] = current;
                queue.push(next);
            }
        }
        current++;
    }
    return component;
}

function largestComponent(component: readonly number[]): number {
    const counts = new Map<number, number>();
    for (const id of component) counts.set(id, (counts.get(id) ?? 0) + 1);
    let best = -1;
    let bestCount = -1;
    for (const [id, count] of counts) {
        if (count > bestCount) {
            bestCount = count;
            best = id;
        }
    }
    return best;
}

function treeOrder(nodeCount: number, tree: readonly GraphEdge[], root: number): number[] {
    const adjacency: number[][] = Array.from({ length: nodeCount }, () => []);
    for (const edge of tree) {
        adjacency[edge.a].push(edge.b);
        adjacency[edge.b].push(edge.a);
    }
    const visited = new Uint8Array(nodeCount);
    const order: number[] = [];
    const stack = [root];
    visited[root] = 1;
    while (stack.length > 0) {
        const node = stack.pop() as number;
        order.push(node);
        for (const next of adjacency[node]) {
            if (visited[next]) continue;
            visited[next] = 1;
            stack.push(next);
        }
    }
    return order;
}

function bestReferenceNode(nodeCount: number, edges: readonly GraphEdge[]): number {
    const score = new Float64Array(nodeCount);
    for (const edge of edges) {
        if (!edge.verified) continue;
        score[edge.a] += edge.inliers;
        score[edge.b] += edge.inliers;
    }
    let best = 0;
    for (let i = 1; i < nodeCount; i++) if (score[i] > score[best]) best = i;
    return best;
}

export class PoseGraph {
    readonly tree: GraphEdge[];
    readonly components: number[];
    readonly mainComponent: number;
    readonly reference: number;
    readonly traversal: number[];

    constructor(
        readonly nodeCount: number,
        readonly edges: GraphEdge[],
    ) {
        this.tree = maximumSpanningTree(nodeCount, edges);
        this.components = connectedComponents(nodeCount, edges);
        this.mainComponent = largestComponent(this.components);
        this.reference = bestReferenceNode(nodeCount, edges);
        this.traversal = nodeCount > 0 ? treeOrder(nodeCount, this.tree, this.reference) : [];
    }

    get componentCount(): number {
        return new Set(this.components).size;
    }

    inMainComponent(node: number): boolean {
        return this.components[node] === this.mainComponent;
    }

    strongestPlacedNeighbour(node: number, placed: ReadonlySet<number>): number {
        let parent = -1;
        let bestInliers = -1;
        for (const edge of this.tree) {
            const other = edge.a === node ? edge.b : edge.b === node ? edge.a : -1;
            if (other >= 0 && placed.has(other) && edge.inliers > bestInliers) {
                parent = other;
                bestInliers = edge.inliers;
            }
        }
        return parent;
    }
}
