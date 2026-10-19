/**
 * What the connection status in the top bar says, for every status the app can hold.
 *
 * `connectionState.status` has five values and only two of them produce a word:
 * 'connected' shows nothing, 'connecting' and 'reconnecting' show a progress label,
 * and 'error' / 'disconnected' show one of two words. The dot colour treats those
 * last two as the same thing; the label does not. That makes the label the entire
 * user-visible difference between the two statuses, and it is worth pinning in its
 * own right — a change to which status a failure lands on is then a change to a
 * sentence, and this test is the sentence.
 *
 * Nothing in the E2E suite reaches `connection-status-button`, so before this the
 * words were unpinned: a status change could alter what the user reads with no test
 * able to notice.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { get } from 'svelte/store';
import TopBar from '#components/TopBar.svelte';
import { connectionState } from '#lib/stores/connectionStore.ts';
import type { ConnectionState } from '#lib/stores/connectionStore.ts';

const components: Record<string, unknown>[] = [];

function render() {
    const target = document.createElement('div');
    document.body.appendChild(target);
    components.push(mount(TopBar, { target, props: {} }));
    flushSync();
    return target;
}

function setStatus(status: ConnectionState['status']) {
    connectionState.update((state) => ({ ...state, status }));
    flushSync();
}

/** The word next to the dot, or '' when the status shows no word. */
function labelOf(target: HTMLElement) {
    return target.querySelector('[data-testid="connection-status-button"] span')!.textContent!.trim();
}

/** The dot's colour and motion tokens: what the dot actually looks like. */
function dotOf(target: HTMLElement) {
    const dot = target.querySelector('.connection-dot')!;
    return [...dot.classList].filter((c) => c.startsWith('bg-') || c.startsWith('animate-')).sort().join(' ');
}

let initial: ConnectionState;

beforeEach(() => {
    initial = { ...get(connectionState) };
});
afterEach(async () => {
    connectionState.set(initial);
    for (const component of components.splice(0)) await unmount(component);
    document.body.replaceChildren();
});

describe('the connection status word', () => {
    it('says nothing while connected', () => {
        const target = render();
        setStatus('connected');
        expect(labelOf(target)).toBe('');
        expect(dotOf(target)).toBe('bg-success');
    });

    it('names the two in-progress states as progress', () => {
        const target = render();

        setStatus('connecting');
        expect(labelOf(target)).toBe('Connecting...');
        expect(dotOf(target)).toBe('animate-pulse bg-warning');

        setStatus('reconnecting');
        expect(labelOf(target)).toBe('Reconnecting...');
        expect(dotOf(target)).toBe('animate-pulse bg-warning');
    });

    it('says "Error" for a failure and "Disconnected" for an absence', () => {
        const target = render();

        setStatus('error');
        expect(labelOf(target)).toBe('Error');

        setStatus('disconnected');
        expect(labelOf(target)).toBe('Disconnected');
    });

    it('colours both of them the same, so the word is the only difference', () => {
        // Recorded because it is what makes the status choice a wording choice:
        // nothing else about the top bar distinguishes these two states.
        const target = render();

        setStatus('error');
        const errorDot = dotOf(target);
        setStatus('disconnected');
        expect(dotOf(target)).toBe(errorDot);
        expect(errorDot).toBe('bg-danger');
    });
});
