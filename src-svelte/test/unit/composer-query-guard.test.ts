/**
 * The composer element is published by the composer, not hunted for by its test id.
 *
 * Six sites used to read `document.querySelector('[data-testid="message-input"]')` — the
 * global key handler (focus, blur, type-to-focus), the chat view's mention click and the
 * nicklist's keyboard activation. Each of those resolves whatever composer happens to be
 * in the document, which is the same as nothing when no composer is mounted and a wrong
 * one if two ever are. `lib/composerInput.ts` hands the element to the page that renders
 * the composer instead.
 *
 * The ban is checked against source text with comments removed, for the same reason the
 * line-id guard does it that way: these modules explain in prose what they replaced, and a
 * comment cannot reintroduce the failure. It is a scan of what is written, so a selector
 * assembled at runtime evades it — the guard is here to stop the obvious regression, not to
 * prove absence. Test code is outside its scope: a spec selecting the composer is exactly
 * what a spec does.
 */
import { describe, expect, it } from 'vitest';
import { codeOf, sourceFiles } from './sourceText';

const SRC_ROOT = 'src-svelte/src';
const COMPOSER = 'src-svelte/src/components/InputBar.svelte';
const PAGE = 'src-svelte/src/routes/+page.svelte';
const SELECTOR = '[data-testid="message-input"]';

/**
 * Any lookup of the composer element. The bracketed selector is banned outright, not just
 * when it reaches `querySelector`: it has no other use in source, because markup writes
 * the attribute without brackets. The call shape is matched with an optional generic, so
 * `querySelector<HTMLTextAreaElement>(…)` cannot slip through the type argument.
 */
function composerLookups(code: string): string[] {
    const lookups: string[] = [];
    if (code.includes(SELECTOR)) lookups.push(`selector ${SELECTOR}`);
    lookups.push(
        ...(code.match(/(?:querySelector|querySelectorAll|getElementById)\s*(?:<[^>]*>)?\s*\([^)]*message-input[^)]*\)/g) ?? []),
    );
    return lookups;
}

describe('the composer is reached through the page, not by its test id', () => {
    it('finds no source file looking the composer up in the document', () => {
        const offenders = sourceFiles(SRC_ROOT)
            .filter((file) => composerLookups(codeOf(file)).length > 0)
            .map((file) => `${file}: ${composerLookups(codeOf(file)).join(', ')}`);

        expect(
            offenders,
            'the composer belongs to one page; publish it through #lib/composerInput.ts so a ' +
                'new site cannot focus, blur or rewrite a composer that is not the page\'s own',
        ).toEqual([]);
    });

    it('keeps publishing the element, so the check above is not a check on nothing', () => {
        const publisher = codeOf(COMPOSER);
        const page = codeOf(PAGE);

        // The composer still renders the test id — a spec reads it — but it hands the
        // element to the page as well.
        expect(publisher).toContain('data-testid="message-input"');
        expect(publisher).toContain('data-testid="message-input"');
        // It publishes the element and only ever reclaims the slot that element holds,
        // so a remount cannot leave the page holding a composer that is gone.
        expect(publisher).toContain('composer.current = element');
        expect(publisher).toContain('if (composer.current === element) composer.current = null');
        expect(page).toContain('setComposerInput(composer)');
    });
});
