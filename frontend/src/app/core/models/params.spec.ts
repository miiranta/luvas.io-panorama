import { DEFAULT_PARAMS, paramValue, withParam } from './params';

describe('params', () => {
    it('reads a parameter by group and key', () => {
        expect(paramValue(DEFAULT_PARAMS, 'model', 'ransacThreshold')).toBe(2.5);
    });

    it('updates a copy without touching the original', () => {
        const next = withParam(DEFAULT_PARAMS, 'compose', 'bands', 6);
        expect(next.compose.bands).toBe(6);
        expect(DEFAULT_PARAMS.compose.bands).toBe(4);
        expect(next.detect).not.toBe(DEFAULT_PARAMS.detect);
    });
});
