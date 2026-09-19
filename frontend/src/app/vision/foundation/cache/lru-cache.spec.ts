import { LruCache } from './lru-cache';

describe('LruCache', () => {
    it('evicts the least recently used entry', () => {
        const evicted: string[] = [];
        const cache = new LruCache<number, string>(2, (value) => evicted.push(value));
        cache.set(1, 'a');
        cache.set(2, 'b');
        cache.get(1);
        cache.set(3, 'c');
        expect(evicted).toEqual(['b']);
        expect(cache.get(1)).toBe('a');
        expect(cache.get(2)).toBeUndefined();
    });

    it('replaces an existing key without evicting', () => {
        const evicted: string[] = [];
        const cache = new LruCache<number, string>(1, (value) => evicted.push(value));
        cache.set(1, 'a');
        cache.set(1, 'b');
        expect(evicted).toEqual([]);
        expect(cache.get(1)).toBe('b');
    });
});
