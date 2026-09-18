import { DESCRIPTOR_WORDS } from '../description/brief-descriptor';

export function hammingDistance(a: Uint32Array, ai: number, b: Uint32Array, bi: number): number {
    let distance = 0;
    for (let w = 0; w < DESCRIPTOR_WORDS; w++) {
        let v = a[ai + w] ^ b[bi + w];
        v = v - ((v >>> 1) & 0x55555555);
        v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
        v = (v + (v >>> 4)) & 0x0f0f0f0f;
        distance += Math.imul(v, 0x01010101) >>> 24;
    }
    return distance;
}
