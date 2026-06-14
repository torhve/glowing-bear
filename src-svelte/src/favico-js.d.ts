declare module 'favico.js' {
    export default class Favico {
        constructor(options?: { bgColor?: string; textColor?: string; fontFamily?: string; fontStyle?: string; type?: string; position?: string; animation?: string });
        badge(count: number): void;
        reset(): void;
    }
}
