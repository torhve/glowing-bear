/**
 * The class vocabulary every form control shares.
 *
 * `FormInput`, `FormSelect` and `FormTextarea` render the same surface — the same
 * background, border, radius, text colour and focus ring — and differ only in what
 * each element additionally needs: a text input carries hover, placeholder and
 * transition classes plus a size-derived padding, while a `<select>` or `<textarea>`
 * keeps symmetric padding and no size prop. Those additions live in the component
 * that needs them; the surface lives here so the three cannot drift apart.
 *
 * `FORM_FIELD_CLASS` is pinned as a token set by `settings-option-rows-contract.test.ts`:
 * because these class strings are reachable from the user-facing Custom CSS field.
 */

/** Background, border, radius, text colour and focus ring. */
export const FORM_SURFACE =
    'w-full bg-input-bg border border-border rounded text-text focus:outline-none focus:border-accent';

/** The surface with the symmetric padding a `<select>` or `<textarea>` carries. */
export const FORM_FIELD_CLASS = `${FORM_SURFACE} px-3 py-2 text-sm`;
