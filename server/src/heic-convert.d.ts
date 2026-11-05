declare module 'heic-convert' {
  export default function convert(opts: {
    buffer: Buffer;
    format: 'JPEG' | 'PNG';
    quality?: number;
  }): Promise<ArrayBuffer>;
}
