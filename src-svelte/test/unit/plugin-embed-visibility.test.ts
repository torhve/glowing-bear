import { afterEach, expect, it } from 'vitest';
import { flushSync, type Component } from 'svelte';
import { fromStore, writable } from 'svelte/store';
import PluginEmbed from '#components/PluginEmbed.svelte';
import type { PluginMetadata } from '#lib/types.ts';
import { mountHarness } from './helpers/mountComponent.ts';

const { render, teardown } = mountHarness();

// Find buttons by their visible label rather than depending on component internals.
function button(target: HTMLElement, label: string) {
    const match = [...target.querySelectorAll('button')].find(el => el.textContent?.trim() === label);
    expect(match, `button labelled "${label}"`).toBeDefined();
    return match!;
}


afterEach(async () => {
    await teardown();
});

it('lets users hide automatic embeds and keeps manual toggles until the setting changes', () => {
    const plugin = writable<PluginMetadata>({
        name: 'Image', className: '', visible: true, nsfw: false, content: 'https://example.test/image.png',
    });
    const reactivePlugin = fromStore(plugin);
    const target = render(PluginEmbed, { get plugin() { return reactivePlugin.current; } });
    const area = target.querySelector<HTMLElement>('.embed-area')!;
    expect(getComputedStyle(area).display).not.toBe('none');


    // Collapsed state must not fetch anything: no preview <img> in the button.
    expect(target.querySelector('[data-testid="show-embed"] img')).toBeNull();

    button(target, 'Collapse').click();
    flushSync();
    expect(getComputedStyle(area).display).toBe('none');

    // Store updates may recreate metadata without changing the automatic-embed setting.
    plugin.update(value => ({ ...value }));
    flushSync();
    expect(getComputedStyle(area).display).toBe('none');

    button(target, 'Show Image').click();
    flushSync();
    expect(getComputedStyle(area).display).not.toBe('none');

    // The expanded state exposes the collapse affordance.
    expect(target.querySelector('[data-testid="hide-embed"]')).not.toBeNull();

    plugin.update(value => ({ ...value, visible: false }));
    flushSync();
    expect(getComputedStyle(area).display).toBe('none');
    button(target, 'Show Image').click();
    flushSync();
    expect(getComputedStyle(area).display).not.toBe('none');
    button(target, 'Collapse').click();
    flushSync();
    expect(getComputedStyle(area).display).toBe('none');

    plugin.update(value => ({ ...value, visible: true }));
    flushSync();
    expect(getComputedStyle(area).display).not.toBe('none');
});
