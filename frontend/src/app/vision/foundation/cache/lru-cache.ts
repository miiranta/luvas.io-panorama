export class LruCache<K, V> {
    private readonly entries = new Map<K, V>();

    constructor(
        private readonly capacity: number,
        private readonly evicted: (value: V) => void = () => undefined,
    ) {}

    get(key: K): V | undefined {
        const value = this.entries.get(key);
        if (value === undefined) return undefined;
        this.entries.delete(key);
        this.entries.set(key, value);
        return value;
    }

    set(key: K, value: V): void {
        this.entries.delete(key);
        this.entries.set(key, value);
        if (this.entries.size <= this.capacity) return;
        const [oldestKey, oldest] = this.entries.entries().next().value as [K, V];
        this.entries.delete(oldestKey);
        this.evicted(oldest);
    }
}
