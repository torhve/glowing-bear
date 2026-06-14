// Minimal emoji shortcode to Unicode mapping
// Matches AngularJS emojify behavior: replaces :shortcode: patterns
// with unicode emoji characters, but only when the result is emoji-only.

const emojiMap: Record<string, string> = {
    ':)': '\u{1F642}',  // 🙂
    ':(' : '\u{1F641}',
    ';)': '\u{1F609}',
    ':D': '\u{1F603}',
    ':P': '\u{1F61B}',
    ':O': '\u{1F62E}',
    '<3': '\u2764\uFE0F',
    '</3': '\u{1F494}',
    ':-)': '\u{1F642}',
    ':-(' : '\u{1F641}',
    ';-)': '\u{1F609}',
    ':-D': '\u{1F603}',
    ':-P': '\u{1F61B}',
    ':-O': '\u{1F62E}',
    'smile': '\u{1F604}',
    'smiley': '\u{1F603}',
    'wink': '\u{1F609}',
    'blush': '\u{1F60A}',
    'heart_eyes': '\u{1F60D}',
    'kissing_heart': '\u{1F618}',
    'relaxed': '\u263A\uFE0F',
    'grin': '\u{1F601}',
    'joy': '\u{1F602}',
    'laughing': '\u{1F606}',
    'innocent': '\u{1F607}',
    'sunglasses': '\u{1F60E}',
    'cry': '\u{1F622}',
    'sob': '\u{1F62D}',
    'disappointed': '\u{1F61E}',
    'angry': '\u{1F620}',
    'rage': '\u{1F621}',
    'sleeping': '\u{1F634}',
    'thumbsup': '\u{1F44D}',
    '+1': '\u{1F44D}',
    'thumbsdown': '\u{1F44E}',
    '-1': '\u{1F44E}',
    'clap': '\u{1F44F}',
    'wave': '\u{1F44B}',
    'ok_hand': '\u{1F44C}',
    'pray': '\u{1F64F}',
    'muscle': '\u{1F4AA}',
    'fire': '\u{1F525}',
    'star': '\u2B50',
    'heart': '\u2764\uFE0F',
    'broken_heart': '\u{1F494}',
    'yellow_heart': '\u{1F49B}',
    'blue_heart': '\u{1F499}',
    'purple_heart': '\u{1F49C}',
    'green_heart': '\u{1F49A}',
    '100': '\u{1F4AF}',
    'tada': '\u{1F389}',
    'rocket': '\u{1F680}',
    'eyes': '\u{1F440}',
    'zzz': '\u{1F4A4}',
    'poop': '\u{1F4A9}',
    'dog': '\u{1F436}',
    'cat': '\u{1F431}',
    'mouse': '\u{1F42D}',
    'hamster': '\u{1F439}',
    'rabbit': '\u{1F430}',
    'fox': '\u{1F98A}',
    'bear': '\u{1F43B}',
    'panda_face': '\u{1F43C}',
    'pig': '\u{1F437}',
    'frog': '\u{1F438}',
    'monkey_face': '\u{1F435}',
    'see_no_evil': '\u{1F648}',
    'hear_no_evil': '\u{1F649}',
    'speak_no_evil': '\u{1F64A}',
    'sunny': '\u2600\uFE0F',
    'umbrella': '\u2614',
    'cloud': '\u2601\uFE0F',
    'rainbow': '\u{1F308}',
    'moon': '\u{1F319}',
    'zap': '\u26A1',
    'snowflake': '\u2744\uFE0F',
    'coffee': '\u2615',
    'tea': '\u{1F375}',
    'beer': '\u{1F37A}',
    'cocktail': '\u{1F378}',
    'pizza': '\u{1F355}',
    'hamburger': '\u{1F354}',
    'fries': '\u{1F35F}',
    'apple': '\u{1F34E}',
    'grapes': '\u{1F347}',
    'cherries': '\u{1F352}',
    'cake': '\u{1F370}',
    'guitar': '\u{1F3B8}',
    'musical_note': '\u{1F3B5}',
    'notes': '\u{1F3B6}',
    'headphones': '\u{1F3A7}',
    'microphone': '\u{1F3A4}',
    'clapper': '\u{1F3AC}',
    'tv': '\u{1F4FA}',
    'computer': '\u{1F4BB}',
    'phone': '\u260E\uFE0F',
    'email': '\u2709\uFE0F',
    'camera': '\u{1F4F7}',
    'video_camera': '\u{1F3F7}',
    'book': '\u{1F4D6}',
    'pencil': '\u270F\uFE0F',
    'checkered_flag': '\u{1F3C1}',
    'check': '\u2705',
    'x': '\u274C',
    'warning': '\u26A0\uFE0F',
    'question': '\u2753',
    'exclamation': '\u2757',
    'tm': '\u2122\uFE0F',
    'copyright': '\u00A9\uFE0F',
    'registered': '\u00AE\uFE0F',
};

/**
 * Converts :shortcode: patterns to Unicode emoji characters.
 * Mirrors AngularJS emojify behavior (inputbar.js).
 */
export function shortnameToUnicode(text: string): string {
    if (!text || !text.startsWith(':') || !text.endsWith(':')) return text;
    const shortcode = text.slice(1, -1);
    return emojiMap[shortcode] || text;
}

/**
 * Emojify an input string: split by whitespace, convert :shortcode:
 * segments to emoji.
 * Returns the emojified string and the adjusted caret position.
 * Mirrors AngularJS emojify behavior exactly (inputbar.js).
 */
export function emojifyInput(input: string, caretPos: number): { text: string; caretPos: number } {
    const segments = input.split(/(\s+)/);
    let changed = false;
    let position = 0;
    let newCaret = caretPos;

    for (let i = 0; i < segments.length; i++) {
        if (/^\s+$/.test(segments[i]!)) {
            position += segments[i]!.length;
            continue;
        }

        const emojified = shortnameToUnicode(segments[i]!);
        if (emojified !== segments[i]) {
            const textLen = segments[i]!.length;
            const diff = emojified.length - textLen;
            if (position + textLen >= newCaret && position < newCaret) {
                newCaret += diff;
                if (newCaret < 0) newCaret = 0;
            }
            segments[i] = emojified;
            changed = true;
        }
        position += segments[i]!.length;
    }

    if (!changed) return { text: input, caretPos };

    return { text: segments.join(''), caretPos: newCaret };
}
