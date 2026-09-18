class ImageDataShim {
    constructor(data, width, height) {
        if (typeof data === 'number') {
            this.width = data;
            this.height = width;
            this.data = new Uint8ClampedArray(this.width * this.height * 4);
        } else {
            this.data = data;
            this.width = width;
            this.height = height ?? data.length / 4 / width;
        }
        this.colorSpace = 'srgb';
    }
}
globalThis.ImageData = globalThis.ImageData ?? ImageDataShim;
