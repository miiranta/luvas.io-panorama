import { GlContext } from './gl-context';

const REQUIRED_SPEEDUP = 0.85;
const MAX_GPU_FAILURES = 3;

export function describeBackend(
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
        if (!enabled) return this.calibration.cpu;
        this.choice ??= this.calibrate();
        return this.choice.backend;
    }

    describe(enabled: boolean): string {
        if (!enabled) return 'cpu (disabled)';
        this.choice ??= this.calibrate();
        const { backend, reason, gpuMs, cpuMs } = this.choice;
        const failures =
            backend instanceof RoutedBackend && backend.failureCount > 0
                ? ` · ${backend.failureCount} failures`
                : '';
        return `${describeBackend(backend.kind, reason, gpuMs, cpuMs)}${failures}`;
    }

    private calibrate(): Choice<T> {
        const { cpu, workloads } = this.calibration;
        const fallback = (reason: string): Choice<T> => ({
            backend: cpu,
            reason,
            gpuMs: null,
            cpuMs: null,
        });
        const context = GlContext.shared();
        if (!context) return fallback('no webgl2');
        if (context.isSoftware) return fallback('software gl');
        const gpu = this.calibration.createGpu(context);
        if (!gpu) return fallback('incomplete webgl2');
        let gpuMs = 0;
        let cpuMs = 0;
        for (const workload of workloads) {
            if (!this.calibration.agrees(gpu, cpu, workload)) return fallback('gpu/cpu mismatch');
            const gpuTime = this.time(gpu, workload);
            const cpuTime = this.time(cpu, workload);
            if (gpuTime === null || cpuTime === null) return fallback('measurement failed');
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
        const started = performance.now();
        if (!this.calibration.run(backend, workload)) return null;
        return performance.now() - started;
    }
}
