/**
 * A dialog component closes the dialog it rendered, through the element it rendered.
 *
 * Both search modals used to end themselves with `document.getElementById(…)`, and
 * ContentSearchModal exported a `dialog` handle that was never bound to anything — so
 * the only real handle was the id string, spelled again at each call site. That works
 * while exactly one element in the document carries the id and breaks quietly when it
 * does not: `?.` turns the missing dialog into a no-op, and the dialog stays open after
 * the user picked a buffer or ran a search.
 *
 * `BaseDialog` exports its `<dialog>` element, so a component that renders one has the
 * element in hand. What remains is the page opening a dialog it did not render
 * (`Alt+G`, `Ctrl+F`), which is the one lookup that legitimately addresses a dialog by
 * id: `popovertarget` is declarative and keyed on the same id, so the id is that
 * dialog's public name rather than an internal handle.
 *
 * Comments are stripped before scanning, as in the other source guards, because these
 * modules explain in prose what they replaced.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { codeOf } from './sourceText';

const COMPONENTS = 'src-svelte/src/components';

/** Every `.svelte` file under `components/`, as text with comments removed. */
function components(): Array<{ file: string; code: string }> {
    return readdirSync(COMPONENTS)
        .filter((name) => name.endsWith('.svelte'))
        .map((name) => join(COMPONENTS, name))
        .map((file) => ({ file, code: codeOf(file) }));
}

/** Anything that finds an element by id: the id is a name, not a handle. */
function idLookups(code: string): string[] {
    return code.match(/getElementById\s*(?:<[^>]*>)?\s*\([^)]*\)/g) ?? [];
}

describe('a dialog reaches its own element, not its id', () => {
    it('no component looks up an element by id', () => {
        const offenders = components()
            .filter((entry) => idLookups(entry.code).length > 0)
            .map((entry) => `${entry.file}: ${idLookups(entry.code).join(', ')}`);
        expect(offenders).toEqual([]);
    });

    it('each dialog id is declared by exactly one component', () => {
        // Two components claiming the same id would make the page's open-by-id and every
        // popovertarget resolve whichever one happens to be earlier in the document.
        const owners: Record<string, string> = {
            'buffer-search-modal': 'BufferSearchModal.svelte',
            'content-search-modal': 'ContentSearchModal.svelte',
        };
        for (const [id, owner] of Object.entries(owners)) {
            const declared = components()
                .filter((entry) => new RegExp(`\\bid\\s*=\\s*"${id}"`).test(entry.code))
                .map((entry) => entry.file);
            expect(declared).toEqual([`${COMPONENTS}/${owner}`]);
        }
    });

    it('the search modals close through the element they bound', () => {
        // Reading the element off BaseDialog is the whole point; a component that went
        // back to the id lookup would fail the test above, and this one fails if the
        // binding itself disappears, which would leave hidePopover() silently dead.
        for (const file of [
            'src-svelte/src/components/BufferSearchModal.svelte',
            'src-svelte/src/components/ContentSearchModal.svelte',
        ]) {
            const code = codeOf(file);
            expect(code).toContain('bind:this={baseDialog}');
            expect(code).toMatch(/baseDialog\?*\.dialog\?*\.hidePopover\(\)/);
        }
    });
});
