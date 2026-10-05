/**
 * Shared loader for the two parsers this package is measured against.
 *
 *   - current:  src-svelte/src/lib/weechat-colors.ts   (`rawText2Rich`, an adapter
 *     over @glowingbear/weechat-format)
 *   - legacy:   src-angular/js/weechat.js              (`WeeChatProtocol.rawText2Rich`)
 *
 * They are imported by absolute URL from outside the package so the library never
 * depends on them at runtime; only the test runner resolves them. Each module is
 * narrowed to the single function the comparisons actually need.
 */

export interface LegacyColor {
    type?: string;
    name?: string;
}

export interface LegacyPart {
    text?: string;
    fgColor?: LegacyColor;
    bgColor?: LegacyColor;
    attrs?: {
        name?: string | null;
        override?: Record<string, unknown>;
    };
}

export interface LegacyParsers {
    /** The parser the Svelte application uses today. */
    current: (input: string) => LegacyPart[];
    /** The adapter's mIRC -> WeeChat translation, which `current` applies first. */
    convertIrcCodes: (input: string) => string;
    /** The original AngularJS parser, kept as a historical baseline. */
    legacy: (input: string) => LegacyPart[];
}

export async function loadLegacyParsers(): Promise<LegacyParsers> {
    const currentModule = (await import(
        new URL('../../../../src-svelte/src/lib/weechat-colors.ts', import.meta.url).href
    )) as unknown as { rawText2Rich: (input: string) => LegacyPart[]; convertIrcCodes: (input: string) => string };
    const legacyModule = (await import(
        new URL('../../../../src-angular/js/weechat.js', import.meta.url).href
    )) as unknown as { Protocol: { rawText2Rich: (input: string) => LegacyPart[] } };
    return {
        current: currentModule.rawText2Rich,
        convertIrcCodes: currentModule.convertIrcCodes,
        legacy: legacyModule.Protocol.rawText2Rich,
    };
}

/**
 * Measure one call of `fn` for `durationMs`, returning the median nanoseconds per
 * call over `samples` independent windows. Warm-up runs first so the first sample
 * is not dominated by lazy compilation.
 */
export function measure(fn: () => void, durationMs = 120, samples = 3): number {
    for (let i = 0; i < 200; i++) fn();

    const results: number[] = [];
    for (let sample = 0; sample < samples; sample++) {
        const start = process.hrtime.bigint();
        let calls = 0;
        while (Number(process.hrtime.bigint() - start) / 1e6 < durationMs) {
            fn();
            calls++;
        }
        results.push(Number(process.hrtime.bigint() - start) / calls);
    }
    results.sort((a, b) => a - b);
    const median = results[Math.floor(results.length / 2)];
    if (median === undefined) {
        throw new Error('measurement produced no samples');
    }
    return median;
}
