/** Shared control-character helpers for the test suites. */

export const CTL = {
    color: '\u0019',
    setAttr: '\u001a',
    removeAttr: '\u001b',
    reset: '\u001c',
    attrBold: '\u0001',
    attrReverse: '\u0002',
    attrItalic: '\u0003',
    attrUnderline: '\u0004',
    attrBlink: '\u0005',
    attrDim: '\u0006',
} as const;

/** Compact rendering of a style for readable assertions. */
export function summarize(style: {
    fg: { kind: string; name?: string; value?: number; index?: number };
    bg: { kind: string; name?: string; value?: number; index?: number };
    attrs: Record<string, string>;
    themeAttrs: string | null;
    emphasis: boolean;
}): string {
    const color = (c: { kind: string; name?: string; value?: number }): string =>
        c.kind === 'default' ? 'default' : c.kind === 'weechat' ? c.name! : c.kind === 'theme' ? `theme:${c.name}` : `ext:${c.value}`;
    const attrs = Object.entries(style.attrs)
        .filter(([, state]) => state !== 'inherited')
        .map(([name, state]) => `${name}${state === 'enabled' ? '+' : '-'}`)
        .sort();
    return [
        `fg=${color(style.fg)}`,
        `bg=${color(style.bg)}`,
        attrs.length > 0 ? `attrs=${attrs.join(',')}` : 'attrs=-',
        style.themeAttrs !== null ? `theme=${style.themeAttrs}` : 'theme=-',
        style.emphasis ? 'emphasis' : 'emphasis=-',
    ].join(' ');
}

/** Compact rendering of runs: `text|style` pairs. */
export function summarizeRuns(runs: readonly { text: string; style: Parameters<typeof summarize>[0] }[]): string[] {
    return runs.map((run) => `${JSON.stringify(run.text)} ${summarize(run.style)}`);
}
