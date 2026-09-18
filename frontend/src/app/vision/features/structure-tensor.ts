import { DetectParams } from '../../core/models/params';
import { blurGray, sobelGradients } from '../imaging/filters';
import { GrayImage } from '../imaging/image';

export type CornerMeasure = 'harris' | 'shi-tomasi';

export interface StructureTensorMaps {
    response: Float32Array;
    gradient: Float32Array;
}

export function cornerMeasure(params: DetectParams): CornerMeasure {
    return params.detector === 'shi-tomasi' ? 'shi-tomasi' : 'harris';
}

function cornerResponse(
    measure: CornerMeasure,
    alpha: number,
    a: number,
    b: number,
    d: number,
): number {
    const det = a * d - b * b;
    const trace = a + d;
    if (measure === 'harris') return det - alpha * trace * trace;
    return (trace - Math.sqrt(Math.max(0, trace * trace - 4 * det))) / 2;
}

export function structureTensorMaps(image: GrayImage, params: DetectParams): StructureTensorMaps {
    const { width, height } = image;
    const n = width * height;
    const { ix, iy, magnitude } = sobelGradients(blurGray(image, params.derivativeSigma));
    const gradient = new Float32Array(n * 4);
    const ixx = new Float32Array(n);
    const iyy = new Float32Array(n);
    const ixy = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        gradient[i * 4] = ix[i];
        gradient[i * 4 + 1] = iy[i];
        gradient[i * 4 + 2] = magnitude[i];
        gradient[i * 4 + 3] = 1;
        ixx[i] = ix[i] * ix[i];
        iyy[i] = iy[i] * iy[i];
        ixy[i] = ix[i] * iy[i];
    }
    const sxx = blurGray({ width, height, data: ixx }, params.integrationSigma).data;
    const syy = blurGray({ width, height, data: iyy }, params.integrationSigma).data;
    const sxy = blurGray({ width, height, data: ixy }, params.integrationSigma).data;
    const measure = cornerMeasure(params);
    const response = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        response[i] = cornerResponse(measure, params.harrisAlpha, sxx[i], sxy[i], syy[i]);
    }
    return { response, gradient };
}
