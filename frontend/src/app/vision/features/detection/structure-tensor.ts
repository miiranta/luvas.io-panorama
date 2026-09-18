import { DetectParams } from '../../../core/models/params';
import { gaussianBlur } from '../../foundation/imaging/gaussian-blur';
import { GrayImage } from '../../foundation/imaging/image';
import { sobelGradients } from '../../foundation/imaging/sobel-gradients';
import { harrisResponse } from './harris';
import { shiTomasiResponse } from './shi-tomasi';

export type CornerMeasure = 'harris' | 'shi-tomasi';

export interface StructureTensorMaps {
    response: Float32Array;
    gradient: Float32Array;
}

export function cornerMeasure(params: DetectParams): CornerMeasure {
    return params.detector === 'shi-tomasi' ? 'shi-tomasi' : 'harris';
}

export function structureTensorMaps(image: GrayImage, params: DetectParams): StructureTensorMaps {
    const { width, height } = image;
    const n = width * height;
    const { ix, iy, magnitude } = sobelGradients(gaussianBlur(image, params.derivativeSigma));
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
    const sxx = gaussianBlur({ width, height, data: ixx }, params.integrationSigma).data;
    const syy = gaussianBlur({ width, height, data: iyy }, params.integrationSigma).data;
    const sxy = gaussianBlur({ width, height, data: ixy }, params.integrationSigma).data;
    const harris = cornerMeasure(params) === 'harris';
    const alpha = params.harrisAlpha;
    const response = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        response[i] = harris
            ? harrisResponse(sxx[i], sxy[i], syy[i], alpha)
            : shiTomasiResponse(sxx[i], sxy[i], syy[i]);
    }
    return { response, gradient };
}
