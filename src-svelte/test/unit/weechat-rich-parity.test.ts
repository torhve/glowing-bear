import { describe, it, expect, beforeEach } from 'vitest';
import { Protocol as NewProtocol, rawText2Rich, RichPart } from '$lib/weechat';

async function loadOldProtocol() {
    const mod = await import('../fixtures/weechat-old.js');
    return (mod as unknown as { Protocol: typeof NewProtocol }).Protocol;
}

let OldProtocol: typeof NewProtocol | null = null;

beforeEach(async () => {
    if (!OldProtocol) {
        try {
            OldProtocol = await loadOldProtocol();
        } catch {
            OldProtocol = null;
        }
    }
});

// Check if override is effectively empty (no true values)
function overridesAreInactive(override: Record<string, boolean>): boolean {
    return Object.values(override).every(v => !v);
}

function hasActiveOverride(override: Record<string, boolean>): boolean {
    return Object.values(override).some(v => v === true);
}

// Old JS uses full name defaults (bold,reverse,italic,underline) + short keys for active attrs
// New TS uses short keys throughout (b,r,i,u,k,d)
const attrKeyMap: Record<string, string> = { bold: 'b', reverse: 'r', italic: 'i', underline: 'u' };

function partsAreEquivalent(n: RichPart, o: RichPart, opts?: { allowTypeMismatch?: boolean; skipBgColor?: boolean }): boolean {
    if (n.text !== o.text) return false;
    // Allow type mismatch for out-of-range color codes (old JS bug: treats 2-digit as option index)
    if (!opts?.allowTypeMismatch) {
        if (n.fgColor.type !== o.fgColor.type) return false;
        if (n.fgColor.name !== o.fgColor.name) return false;
        if (!opts?.skipBgColor) {
            if (n.bgColor.type !== o.bgColor.type) return false;
            if (n.bgColor.name !== o.bgColor.name) return false;
        }
    }
    // For out-of-range codes, attrs.name also differs (null vs option name)
    if (!opts?.allowTypeMismatch && n.attrs.name !== o.attrs.name) return false;
    // Override equivalence: {} and {b:false,...} are both "inactive"
    const nActive = hasActiveOverride(n.attrs.override);
    const oActive = hasActiveOverride(o.attrs.override);
    if (nActive !== oActive) return false;
    // Normalize old JS override keys to short form for comparison.
    // Old JS uses full name defaults (bold,reverse,italic,underline) + short keys for active attrs.
    // When both bold:false and b:true exist, the explicit short key wins.
    const oNormalized: Record<string, boolean> = {};
    for (const k in o.attrs.override) {
        const mapped = attrKeyMap[k] ?? k;
        oNormalized[mapped] = o.attrs.override[k];
    }
    // If both have active attrs, check specific keys match
    if (nActive) {
        const allKeys = new Set([...Object.keys(n.attrs.override), ...Object.keys(oNormalized)]);
        for (const key of allKeys) {
            const nVal = n.attrs.override[key] || false;
            const oVal = oNormalized[key] || false;
            if (nVal !== oVal) return false;
        }
    }
    return true;
}

function compareRichParts(newParts: RichPart[], oldParts: RichPart[], opts?: { allowTypeMismatch?: boolean; skipBgColor?: boolean }): boolean {
    if (newParts.length !== oldParts.length) return false;
    for (let i = 0; i < newParts.length; i++) {
        if (!partsAreEquivalent(newParts[i]!, oldParts[i]!, opts)) return false;
    }
    return true;
}

describe('richText2Rich parity: new vs old JS parser', () => {
    it('parses plain text identically', async () => {
        expect(OldProtocol).not.toBeNull();
        const input = 'Hello world';
        const newResult = rawText2Rich(input);
        const oldResult = OldProtocol.rawText2Rich(input);
        expect(compareRichParts(newResult, oldResult)).toBe(true);
    });

    it('parses empty string identically', async () => {
        expect(OldProtocol).not.toBeNull();
        const input = '';
        const newResult = rawText2Rich(input);
        const oldResult = OldProtocol.rawText2Rich(input);
        expect(compareRichParts(newResult, oldResult)).toBe(true);
    });

    it('parses F foreground color with no attrs identically', async () => {
        expect(OldProtocol).not.toBeNull();
        const input = '\x19F03red text';
        const newResult = rawText2Rich(input);
        const oldResult = OldProtocol.rawText2Rich(input);
        expect(compareRichParts(newResult, oldResult)).toBe(true);
    });

    it('parses F foreground color with attrs identically', async () => {
        expect(OldProtocol).not.toBeNull();
        const input = '\x19F*03bold red text';
        const newResult = rawText2Rich(input);
        const oldResult = OldProtocol.rawText2Rich(input);
        expect(compareRichParts(newResult, oldResult)).toBe(true);
    });

    it('parses STD color code (date change prefix) identically', async () => {
        expect(OldProtocol).not.toBeNull();
        const input = '\x1904\u2500\u2500\u2500';
        const newResult = rawText2Rich(input);
        const oldResult = OldProtocol.rawText2Rich(input);
        // Old JS has bgColor bug for STD colors; skip bg comparison
        expect(compareRichParts(newResult, oldResult, { skipBgColor: true })).toBe(true);
    });

    it('parses out-of-range STD color code (old JS has bug, allows type mismatch)', async () => {
        expect(OldProtocol).not.toBeNull();
        const input = '\x1928(Leaving\x1c';
        const newResult = rawText2Rich(input);
        const oldResult = OldProtocol.rawText2Rich(input);
        // Old JS treats 2-digit codes as option indices (bug for >15), TS preserves current colors
        expect(compareRichParts(newResult, oldResult, { allowTypeMismatch: true, skipBgColor: true })).toBe(true);
    });

    it('parses foreground+background with * identically', async () => {
        expect(OldProtocol).not.toBeNull();
        const input = '\x19*03,07highlighted\x1c';
        const newResult = rawText2Rich(input);
        const oldResult = OldProtocol.rawText2Rich(input);
        expect(compareRichParts(newResult, oldResult)).toBe(true);
    });

    it('parses attribute set/reset identically', async () => {
        expect(OldProtocol).not.toBeNull();
        const input = '\x1a*bold\x1b/unbold text';
        const newResult = rawText2Rich(input);
        const oldResult = OldProtocol.rawText2Rich(input);
        expect(compareRichParts(newResult, oldResult)).toBe(true);
    });

    it('parses color reset \x1c identically', async () => {
        expect(OldProtocol).not.toBeNull();
        const input = '\x1903red\x1cdefault';
        const newResult = rawText2Rich(input);
        const oldResult = OldProtocol.rawText2Rich(input);
        // Old JS has bgColor bug for STD colors; skip bg comparison
        expect(compareRichParts(newResult, oldResult, { skipBgColor: true })).toBe(true);
    });

    it('parses emphasis E code identically', async () => {
        expect(OldProtocol).not.toBeNull();
        const input = 'Eemphasized text';
        const newResult = rawText2Rich(input);
        const oldResult = OldProtocol.rawText2Rich(input);
        // Old JS has bgColor bug for E; skip bg comparison
        expect(compareRichParts(newResult, oldResult, { skipBgColor: true })).toBe(true);
    });

    it('parses multiple style changes identically', async () => {
        expect(OldProtocol).not.toBeNull();
        const input = '\x1903red\x1900normal\x1902green';
        const newResult = rawText2Rich(input);
        const oldResult = OldProtocol.rawText2Rich(input);
        // Old JS has bgColor bug for STD colors; skip bg comparison
        expect(compareRichParts(newResult, oldResult, { skipBgColor: true })).toBe(true);
    });

    it('parses mIRC color codes (converted before parsing) identically', async () => {
        expect(OldProtocol).not.toBeNull();
        // \x0302 → \x1902, \x03 at end → \x1c
        const input = '\x1902Bold\x1c Normal';
        const newResult = rawText2Rich(input);
        const oldResult = OldProtocol.rawText2Rich(input);
        // Old JS has bgColor bug for STD colors; skip bg comparison
        expect(compareRichParts(newResult, oldResult, { skipBgColor: true })).toBe(true);
    });

    it('parses IRC bold + reset identically', async () => {
        expect(OldProtocol).not.toBeNull();
        // \x02 → \x1a*, \x0f → \x1c
        const input = '\x1a*bold text\x1creset';
        const newResult = rawText2Rich(input);
        const oldResult = OldProtocol.rawText2Rich(input);
        expect(compareRichParts(newResult, oldResult)).toBe(true);
    });

    it('parses \x0328(Leaving\x03 pattern identically', async () => {
        expect(OldProtocol).not.toBeNull();
        // \x0328 → \x1928, \x03 at end → \x1c
        const input = '\x1928(Leaving\x1c';
        const newResult = rawText2Rich(input);
        const oldResult = OldProtocol.rawText2Rich(input);
        // Out-of-range color code: allow type mismatch + skip bgColor (old JS bug)
        expect(compareRichParts(newResult, oldResult, { allowTypeMismatch: true, skipBgColor: true })).toBe(true);
    });

    it('parses background color B code identically', async () => {
        expect(OldProtocol).not.toBeNull();
        const input = '\x19B07backgrounded';
        const newResult = rawText2Rich(input);
        const oldResult = OldProtocol.rawText2Rich(input);
        expect(compareRichParts(newResult, oldResult)).toBe(true);
    });

    it('parses extended color code @12345 identically (unimplemented)', async () => {
        expect(OldProtocol).not.toBeNull();
        const input = '\x19@12345colored text';
        const newResult = rawText2Rich(input);
        const oldResult = OldProtocol.rawText2Rich(input);
        expect(compareRichParts(newResult, oldResult)).toBe(true);
    });

    it('parses foreground+bg with attrs and * identically', async () => {
        expect(OldProtocol).not.toBeNull();
        const input = '\x19*!03,07inverse bg';
        const newResult = rawText2Rich(input);
        const oldResult = OldProtocol.rawText2Rich(input);
        expect(compareRichParts(newResult, oldResult)).toBe(true);
    });

    it('parses mixed attributes and colors identically', async () => {
        expect(OldProtocol).not.toBeNull();
        const input = '\x1a*bold\x1903red bold\x1b/unbold\x1900normal';
        const newResult = rawText2Rich(input);
        const oldResult = OldProtocol.rawText2Rich(input);
        // Old JS has bgColor bug for STD colors; skip bg comparison
        expect(compareRichParts(newResult, oldResult, { skipBgColor: true })).toBe(true);
    });

    it('parses unicode styled text identically', async () => {
        expect(OldProtocol).not.toBeNull();
        const input = '\x1904\u2764\u2764\u2764\x1cplain';
        const newResult = rawText2Rich(input);
        const oldResult = OldProtocol.rawText2Rich(input);
        // Old JS has bgColor bug for STD colors; skip bg comparison
        expect(compareRichParts(newResult, oldResult, { skipBgColor: true })).toBe(true);
    });

    it('parses \x1a| keep attrs identically', async () => {
        expect(OldProtocol).not.toBeNull();
        const input = '\x1a*bold\x1a/italic\x1a|keep both';
        const newResult = rawText2Rich(input);
        const oldResult = OldProtocol.rawText2Rich(input);
        expect(compareRichParts(newResult, oldResult)).toBe(true);
    });

    it('parses \x1b| reset keep identically', async () => {
        expect(OldProtocol).not.toBeNull();
        const input = '\x1a*bold\x1b|keep bold after reset';
        const newResult = rawText2Rich(input);
        const oldResult = OldProtocol.rawText2Rich(input);
        expect(compareRichParts(newResult, oldResult)).toBe(true);
    });

    it('parses multiple STD color codes in sequence identically', async () => {
        expect(OldProtocol).not.toBeNull();
        const input = '\x1900start\x1901blue\x1902green\x1903red\x1904darkred\x1905brown';
        const newResult = rawText2Rich(input);
        const oldResult = OldProtocol.rawText2Rich(input);
        // Old JS has bgColor bug for STD colors; skip bg comparison
        expect(compareRichParts(newResult, oldResult, { skipBgColor: true })).toBe(true);
    });

    it('parses F with EXT color code identically', async () => {
        expect(OldProtocol).not.toBeNull();
        const input = '\x19F\x0103bold via ext';
        const newResult = rawText2Rich(input);
        const oldResult = OldProtocol.rawText2Rich(input);
        expect(compareRichParts(newResult, oldResult)).toBe(true);
    });

    it('parses * with STD + bg EXT identically', async () => {
        expect(OldProtocol).not.toBeNull();
        const input = '\x19*03,@\x0100456fg bg';
        const newResult = rawText2Rich(input);
        const oldResult = OldProtocol.rawText2Rich(input);
        expect(compareRichParts(newResult, oldResult)).toBe(true);
    });

    it('parses all attribute chars identically', async () => {
        expect(OldProtocol).not.toBeNull();
        const input = '\x1a*\x1a!\x1a/\x1a_underlined';
        const newResult = rawText2Rich(input);
        const oldResult = OldProtocol.rawText2Rich(input);
        expect(compareRichParts(newResult, oldResult)).toBe(true);
    });

    it('parses \x01-\x04 extension chars identically (bold via \x01)', async () => {
        expect(OldProtocol).not.toBeNull();
        const input = '\x19F\x0103bold via ext';
        const newResult = rawText2Rich(input);
        const oldResult = OldProtocol.rawText2Rich(input);
        expect(compareRichParts(newResult, oldResult)).toBe(true);
    });

    it('parses IRC color fg+bg identically', async () => {
        expect(OldProtocol).not.toBeNull();
        // \x0312,04 → \x19*12,04, trailing \x03 → \x1c
        const input = '\x19*12,04fg bg color\x1c more';
        const newResult = rawText2Rich(input);
        const oldResult = OldProtocol.rawText2Rich(input);
        expect(compareRichParts(newResult, oldResult)).toBe(true);
    });

    it('parses bare \x03 reset identically', async () => {
        expect(OldProtocol).not.toBeNull();
        // bare \x03 → \x1c (reset all)
        const input = '\x1creset colors';
        const newResult = rawText2Rich(input);
        const oldResult = OldProtocol.rawText2Rich(input);
        expect(compareRichParts(newResult, oldResult)).toBe(true);
    });
});

describe('attrsFromStr behavior via rawText2Rich', () => {
    it('empty attr group resets attrs (parity with old JS)', async () => {
        // STD colors reset attrs to empty override — bold is lost in both TS and old JS
        // bgColor differs between implementations (option vs weechat default) but attrs/fgColor match
        expect(OldProtocol).not.toBeNull();
        const input = '\x1a*bold\x1903color\x1904more';
        const newResult = rawText2Rich(input);
        const oldResult = OldProtocol.rawText2Rich(input);
        expect(compareRichParts(newResult, oldResult, { skipBgColor: true })).toBe(true);
    });

    it('F code without attrs resets attrs (parity with old JS)', async () => {
        // F03 has no attribute prefix — resets to fresh attrs with all-false overrides in both
        expect(OldProtocol).not.toBeNull();
        const input = '\x1a*bold\x19F03red';
        const newResult = rawText2Rich(input);
        const oldResult = OldProtocol.rawText2Rich(input);
        expect(compareRichParts(newResult, oldResult)).toBe(true);
        const redPart = newResult.find(p => p.text === 'red');
        expect(redPart).toBeDefined();
        expect(hasActiveOverride(redPart!.attrs.override)).toBe(false);
    });

    it('| character mid-string returns null (keep attrs)', async () => {
        // | in the attribute string means "keep current"
        // For \x1a|, the TS parser checks firstChar !== '|' and skips
        // Text includes the pipe character since it's part of the raw string
        const result = rawText2Rich('\x1a*bold\x1a|keep both');
        const keepPart = result.find(p => p.text === '|keep both');
        expect(keepPart).toBeDefined();
        expect(hasActiveOverride(keepPart!.attrs.override)).toBe(true);
    });
});
