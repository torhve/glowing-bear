/**
 * @glowingbear/weechat-format — a dependency-free decoder for the WeeChat
 * inline chat color/attribute protocol, following WeeChat 4.10.1 semantics.
 *
 * Public surface: two parse functions, the domain types, the constant tables
 * consumers need to resolve symbolic color references, and the initial style.
 * The instruction decoder is deliberately not exported.
 */

export { parseWeeChatStyle, parseWeeChatText } from './parse.js';
export { INITIAL_STYLE, stylesEqual } from './style.js';

export {
    MAX_EXTENDED_COLOR,
    MAX_THEME_COLOR,
    MAX_WEECHAT_COLOR,
    THEME_COLORS,
    WEECHAT_PALETTE,
} from './tables.js';
export type { BarReference } from './tables.js';

export type {
    AttributeName,
    AttributeState,
    Attributes,
    ColorRef,
    DiagnosticReason,
    ParseDiagnostic,
    ParseOptions,
    Style,
    StyleParseResult,
    TextRun,
    ThemeColorName,
    WeechatColorName,
} from './types.js';
