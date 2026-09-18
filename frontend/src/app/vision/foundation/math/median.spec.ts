import { median } from './median';

describe('median', () => {
    it('returns null for no values', () => {
        expect(median([])).toBeNull();
    });

    it('returns the middle value of an odd count', () => {
        expect(median([9, 1, 5])).toBe(5);
    });

    it('averages the two middle values of an even count', () => {
        expect(median([4, 1, 3, 2])).toBe(2.5);
    });

    it('does not reorder the input', () => {
        const values = [3, 1, 2];
        median(values);
        expect(values).toEqual([3, 1, 2]);
    });
});
