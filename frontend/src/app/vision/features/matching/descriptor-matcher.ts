import { MatchParams } from '../../../core/models/params';
import { MatchBackend, NO_DISTANCE, cpuMatchBackend } from './match-backend';

export interface RawMatch {
    queryIndex: number;
    trainIndex: number;
    accepted: boolean;
}

export class DescriptorMatcher {
    constructor(private readonly backend: MatchBackend = cpuMatchBackend) {}

    match(
        query: Uint32Array,
        queryCount: number,
        train: Uint32Array,
        trainCount: number,
        params: MatchParams,
    ): RawMatch[] {
        if (queryCount === 0 || trainCount === 0) return [];
        const forward = this.nearest(query, queryCount, train, trainCount);
        if (!forward) return [];
        const reverse = params.crossCheck
            ? (this.nearest(train, trainCount, query, queryCount)?.index ?? null)
            : null;
        const matches: RawMatch[] = [];
        for (let q = 0; q < queryCount; q++) {
            const trainIndex = forward.index[q];
            if (trainIndex < 0) continue;
            const second = forward.second[q];
            const ratio = second === 0 || second >= NO_DISTANCE ? 1 : forward.best[q] / second;
            const mutual = !reverse || reverse[trainIndex] === q;
            matches.push({
                queryIndex: q,
                trainIndex,
                accepted: ratio < params.loweRatio && mutual,
            });
        }
        return matches;
    }

    private nearest(
        query: Uint32Array,
        queryCount: number,
        train: Uint32Array,
        trainCount: number,
    ) {
        return (
            this.backend.nearest(query, queryCount, train, trainCount) ??
            cpuMatchBackend.nearest(query, queryCount, train, trainCount)
        );
    }
}
