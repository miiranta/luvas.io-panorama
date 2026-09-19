import { GlContext } from './gl-context';

const REQUIRED_SPEEDUP = 0.85;
const MAX_GPU_FAILURES = 3;
const TIMING_RUNS = 3;

function describeBackend(
    kind: string,
    reason: string,
    gpuMs: number | null,
    cpuMs: number | null,
): string {
    const timing =
        gpuMs !== null && cpuMs !== null
            ? ` · gpu ${gpuMs.toFixed(1)}ms vs cpu ${cpuMs.toFixed(1)}ms`
            : '';
    return `${kind} (${reason})${timing}`;
}

export interface Backend {
    readonly kind: string;
}

export abstract class RoutedBackend<T extends Backend> implements Backend {
    readonly kind = 'webgl2';
    private failures = 0;

    constructor(
        protected readonly gpu: T,
        protected readonly cpu: T,
        readonly threshold: number,
    ) {}

    get failureCount(): number {
        return this.failures;
    }

    protected route<R>(workload: number, call: (backend: T) => R | null): R | null {
        if (workload >= this.threshold && this.failures < MAX_GPU_FAILURES) {
            const result = call(this.gpu);
            if (result !== null) return result;
            this.failures++;
        }
        return call(this.cpu);
    }
}

export interface Calibration<T extends Backend> {
    readonly cpu: T;
    readonly workloads: readonly number[];
    readonly timingRuns?: number;
    createGpu(context: GlContext): T | null;
    agrees(gpu: T, cpu: T, workload: number): boolean;
    run(backend: T, workload: number): boolean;
    route(gpu: T, cpu: T, threshold: number): RoutedBackend<T> & T;
    describeWorkload(workload: number): string;
}

interface Choice<T> {
    backend: T;
    reason: string;
    gpuMs: number | null;
    cpuMs: number | null;
}

export class BackendSelector<T extends Backend> {
    private choice: Choice<T> | null = null;

    constructor(private readonly calibration: Calibration<T>) {}

    select(enabled: boolean): T {
        return enabled ? this.decide().backend : this.calibration.cpu;
    }

    describe(enabled: boolean): string {
        if (!enabled) return 'cpu (disabled)';
        const { backend, reason, gpuMs, cpuMs } = this.decide();
        const failures =
            backend instanceof RoutedBackend && backend.failureCount > 0
                ? ` · ${backend.failureCount} failures`
                : '';
        return `${describeBackend(backend.kind, reason, gpuMs, cpuMs)}${failures}`;
    }

    private decide(): Choice<T> {
        if (!this.choice) {
            try {
                this.choice = this.calibrate();
            } catch {
                this.choice = this.fallback('calibration failed');
            }
        }
        return this.choice;
    }

    private fallback(reason: string): Choice<T> {
        return { backend: this.calibration.cpu, reason, gpuMs: null, cpuMs: null };
    }

    private calibrate(): Choice<T> {
        const { cpu, workloads } = this.calibration;
        const context = GlContext.shared();
        if (!context) return this.fallback('no webgl2');
        if (context.isSoftware) return this.fallback('software gl');
        const gpu = this.calibration.createGpu(context);
        if (!gpu) return this.fallback('incomplete webgl2');
        let gpuMs = 0;
        let cpuMs = 0;
        for (const workload of workloads) {
            if (!this.calibration.agrees(gpu, cpu, workload))
                return this.fallback('gpu/cpu mismatch');
            const gpuTime = this.time(gpu, workload);
            const cpuTime = this.time(cpu, workload);
            if (gpuTime === null || cpuTime === null) return this.fallback('measurement failed');
            gpuMs = gpuTime;
            cpuMs = cpuTime;
            if (gpuMs < cpuMs * REQUIRED_SPEEDUP) {
                const first = workload === workloads[0];
                return {
                    backend: this.calibration.route(gpu, cpu, first ? 0 : workload),
                    reason: first
                        ? 'gpu faster'
                        : `gpu from ${this.calibration.describeWorkload(workload)}`,
                    gpuMs,
                    cpuMs,
                };
            }
        }
        return { backend: cpu, reason: 'cpu faster', gpuMs, cpuMs };
    }

    private time(backend: T, workload: number): number | null {
        let fastest = Number.POSITIVE_INFINITY;
        for (let run = 0; run < (this.calibration.timingRuns ?? TIMING_RUNS); run++) {
            const started = performance.now();
            if (!this.calibration.run(backend, workload)) return null;
            fastest = Math.min(fastest, performance.now() - started);
        }
        return fastest;
    }
}
