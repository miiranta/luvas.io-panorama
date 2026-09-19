import { Backend, BackendSelector, Calibration, RoutedBackend } from './backend-selector';

interface Doubler extends Backend {
    double(value: number): number | null;
}

class RoutedDoubler extends RoutedBackend<Doubler> implements Doubler {
    double(value: number): number | null {
        return this.route(value, (backend) => backend.double(value));
    }
}

const cpu: Doubler = { kind: 'cpu', double: (value) => value * 2 };

function gpu(results: (number | null)[]): Doubler & { calls: number } {
    const backend = {
        kind: 'webgl2',
        calls: 0,
        double(): number | null {
            return results[backend.calls++] ?? null;
        },
    };
    return backend;
}

describe('RoutedBackend', () => {
    it('sends small workloads to the CPU and large ones to the GPU', () => {
        const fast = gpu([100]);
        const routed = new RoutedDoubler(fast, cpu, 10);
        expect(routed.double(3)).toBe(6);
        expect(routed.double(20)).toBe(100);
        expect(fast.calls).toBe(1);
    });

    it('falls back to the CPU on GPU failure and stops trying after three', () => {
        const broken = gpu([]);
        const routed = new RoutedDoubler(broken, cpu, 0);
        for (let i = 0; i < 5; i++) expect(routed.double(21)).toBe(42);
        expect(broken.calls).toBe(3);
        expect(routed.failureCount).toBe(3);
    });
});

describe('BackendSelector', () => {
    const calibration: Calibration<Doubler> = {
        cpu,
        workloads: [1],
        createGpu: () => gpu([2]),
        agrees: () => true,
        run: () => true,
        route: (g, c, threshold) => new RoutedDoubler(g, c, threshold),
        describeWorkload: (workload) => `${workload}`,
    };

    it('uses the CPU when acceleration is disabled', () => {
        const selector = new BackendSelector(calibration);
        expect(selector.select(false)).toBe(cpu);
        expect(selector.describe(false)).toBe('cpu (disabled)');
    });

    it('falls back to the CPU without WebGL2 and says why', () => {
        const selector = new BackendSelector(calibration);
        expect(selector.select(true)).toBe(cpu);
        expect(selector.describe(true)).toBe('cpu (no webgl2)');
    });
});
