declare module 'zlibjs/bin/inflate.min' {
    export class Zlib {
        static Inflate: new (data: Uint8Array) => { decompress(): Uint8Array };
    }
}
