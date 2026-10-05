// The nicklist must show WeeChat's `root` group (nicks with no group) as bare
// rows above the grouped sections — they were previously dropped entirely.
import { describe, it, expect, afterEach } from 'vitest';
import { flushSync, mount, unmount, type Component } from 'svelte';
import Nicklist from '#components/Nicklist.svelte';
import { activeBufferId, buffers, createBuffer } from '#lib/stores/models.ts';
import type { BufferData, Nick, NickGroup } from '#lib/types.ts';

const components: Component<Record<string, unknown>>[] = [];

// Mount the real component and retain its owner so each test tears down its effects.
function render<Props extends Record<string, unknown>>(component: Component<Props>, props: Props) {
    const target = document.createElement('div');
    document.body.appendChild(target);
    components.push(mount(component, { target, props }));
    flushSync();
    return target;
}

function nick(name: string): Nick {
    return { prefix: '', visible: '1', name, prefixClasses: [], nameClasses: [], buffer: '1' };
}

function group(name: string, nicks: Nick[]): NickGroup {
    return { name, visible: '1', nicks };
}

function showNicklist(groups: Record<string, Nick[]>) {
    const base: BufferData = createBuffer({
        pointers: ['0x1'],
        full_name: 'irc.gbtest.#glowing-bear',
        short_name: '#glowing-bear',
        title: [],
        hidden: 0,
        number: 1,
        type: 0,
        local_variables: { type: 'channel', irc: 'gbtest', channel: '#glowing-bear' },
    });
    const buf: BufferData = {
        ...base,
        nicklist: Object.fromEntries(
            Object.entries(groups).map(([name, nicks]) => [name, group(name, nicks)]),
        ),
    };
    activeBufferId.set(buf.id);
    buffers.set({ [buf.id]: buf });
    flushSync();
}

afterEach(() => {
    for (const component of components.splice(0)) unmount(component);
    document.body.replaceChildren();
    activeBufferId.set('');
    buffers.set({});
});

describe('nicklist root rows', () => {
    it('renders root-group nicks as bare rows before the grouped sections', () => {
        showNicklist({
            root: [nick('alice'), nick('bob')],
            'irc.gbtest.#glowing-bear': [nick('carol')],
        });
        const target = render(Nicklist, { forceShow: true });

        const names = [...target.querySelectorAll('[data-testid="nick-item"]')].map(
            (el) => el.querySelector('.nick-name')?.textContent?.trim(),
        );
        expect(names).toEqual(['alice', 'bob', 'carol']);

        // Root rows have no section box; only the one grouped section has one.
        expect(target.querySelectorAll('.nick-group')).toHaveLength(1);
    });

    it('shows the nicklist for a buffer whose only nicks are ungrouped', () => {
        showNicklist({ root: [nick('alice')] });
        const target = render(Nicklist, { forceShow: true });

        expect(target.querySelectorAll('[data-testid="nick-item"]')).toHaveLength(1);
        expect(target.querySelectorAll('.nick-group')).toHaveLength(0);
    });

    it('keeps a buffer without a root group unchanged', () => {
        showNicklist({ 'irc.gbtest.#glowing-bear': [nick('carol')] });
        const target = render(Nicklist, { forceShow: true });

        expect(target.querySelectorAll('[data-testid="nick-item"]')).toHaveLength(1);
        expect(target.querySelectorAll('.nick-group')).toHaveLength(1);
    });
});
