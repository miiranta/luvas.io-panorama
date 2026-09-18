import { Keypoint } from '../features/detection/keypoint';
import { ColorImage, imageCentre } from '../foundation/imaging/image';
import { Mat3, mat3Identity } from '../foundation/math/matrix3';

const ARCHIVE_QUALITY = 0.94;

export class Keyframe {
    rotation: Mat3;
    gain = 1;
    rejected = false;
    composedRotation: Mat3 | null = null;
    readonly composeWidth: number;
    readonly composeHeight: number;
    private archive: Blob | null = null;

    constructor(
        readonly id: number,
        readonly label: string,
        readonly workWidth: number,
        readonly workHeight: number,
        readonly keypoints: Keypoint[],
        readonly descriptors: Uint32Array,
        public work: ColorImage | null,
        private compose: ColorImage | null,
        rotation: Mat3 = mat3Identity(),
    ) {
        this.rotation = rotation;
        this.composeWidth = compose?.width ?? 0;
        this.composeHeight = compose?.height ?? 0;
    }

    static get canArchive(): boolean {
        return typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap !== 'undefined';
    }

    get committed(): boolean {
        return this.composedRotation !== null;
    }

    get centreX(): number {
        return imageCentre(this.workWidth);
    }

    get centreY(): number {
        return imageCentre(this.workHeight);
    }

    get hasComposeSource(): boolean {
        return this.compose !== null || this.archive !== null;
    }

    get storedBytes(): number {
        return (
            this.descriptors.byteLength +
            (this.archive?.size ?? 0) +
            (this.compose?.data.byteLength ?? 0) +
            (this.work?.data.byteLength ?? 0)
        );
    }

    commit(): void {
        this.composedRotation = Float64Array.from(this.rotation) as Mat3;
    }

    uncommit(): void {
        this.composedRotation = null;
    }

    reject(keepSource = false): void {
        this.rejected = true;
        this.work = null;
        if (keepSource) return;
        this.compose = null;
        this.archive = null;
    }

    async composeImage(): Promise<ColorImage | null> {
        if (this.compose) return this.compose;
        if (!this.archive) return null;
        const bitmap = await createImageBitmap(this.archive);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) {
            bitmap.close();
            return null;
        }
        context.drawImage(bitmap, 0, 0);
        const data = context.getImageData(0, 0, bitmap.width, bitmap.height);
        bitmap.close();
        return {
            width: data.width,
            height: data.height,
            data: data.data as Uint8ClampedArray<ArrayBuffer>,
        };
    }

    async archiveCompose(): Promise<void> {
        if (!this.archive && this.compose && Keyframe.canArchive) {
            const { width, height, data } = this.compose;
            const canvas = new OffscreenCanvas(width, height);
            const context = canvas.getContext('2d');
            if (!context) return;
            context.putImageData(new ImageData(data, width, height), 0, 0);
            this.archive = await canvas.convertToBlob({
                type: 'image/jpeg',
                quality: ARCHIVE_QUALITY,
            });
        }
        if (this.archive) this.compose = null;
    }
}
