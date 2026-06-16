// Detects WeeChat prefix patterns and maps them to Lucide icon types.
// Returns null if no pattern matches (text rendered normally).

export type PrefixIconType = 'arrow-right' | 'arrow-left' | 'chevron-left' | 'chevron-right' | 'minus';

const PATTERNS: Array<{ regex: RegExp; icon: PrefixIconType }> = [
    { regex: /^-->\s*$/, icon: 'arrow-right' },
    { regex: /^<--\s*$/, icon: 'arrow-left' },
    { regex: /^- ->\s*$/, icon: 'arrow-right' },
    { regex: /^◀▬▬\s*$/, icon: 'chevron-left' },
    { regex: /^▬▬▶\s*$/, icon: 'chevron-right' },
    { regex: /^--\s*$/, icon: 'minus' }
];

/**
 * Check if a prefix part text matches a known icon pattern.
 * Returns the icon type if matched, null otherwise.
 */
export function detectPrefixIcon(text: string): PrefixIconType | null {
    for (const { regex, icon } of PATTERNS) {
        if (regex.test(text)) return icon;
    }
    return null;
}
