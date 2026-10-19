/**
 * Constrain a number to an inclusive range.
 *
 * The call sites this replaces were written both ways — `Math.min(Math.max(v, lo), hi)`
 * and `Math.max(lo, Math.min(v, hi))`. The two orders give different answers only when
 * lo > hi, which none of them allow, so collapsing them changes nothing. What the name
 * does buy is that a range like the font-size bounds can be written once as a pair of
 * constants instead of as two numbers repeated inside an expression.
 */
export function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}
