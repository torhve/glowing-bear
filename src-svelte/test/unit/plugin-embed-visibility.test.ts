import { afterEach, expect, it } from 'vitest';
import { flushSync, mount, unmount, type Component } from 'svelte';
import { fromStore, writable } from 'svelte/store';
import PluginEmbed from '#components/PluginEmbed.svelte';
import type { PluginMetadata } from '#lib/types.ts';

const components: Record<string, unknown>[] = [];

// Mount the real component and retain its owner so each test tears down its effects.
function render<Props extends Record<string, unknown>>(component: Component<Props>, props: Props) {
    const target = document.createElement('div');
    document.body.appendChild(target);
    components.push(mount(component, { target, props }));
    flushSync();
    return target;
}

// Find buttons by their visible label rather than depending on component internals.
function button(target: HTMLElement, label: string) {
    const match = [...target.querySelectorAll('button')].find(el => el.textContent?.trim() === label);
    expect(match, `button labelled "${label}"`).toBeDefined();
    return match!;
}


afterEach(async () => {
    for (const component of components.splice(0)) await unmount(component);
    document.body.replaceChildren();
});

it('lets users hide automatic embeds and keeps manual toggles until the setting changes', () => {
    const plugin = writable<PluginMetadata>({
        name: 'Image', className: '', visible: true, nsfw: false, content: 'https://example.test/image.png',
    });
    const reactivePlugin = fromStore(plugin);
    const target = render(PluginEmbed, { get plugin() { return reactivePlugin.current; } });
    const area = target.querySelector<HTMLElement>('.embed-area')!;
    expect(getComputedStyle(area).display).not.toBe('none');

    button(target, 'Hide Image').click();
    flushSync();
    expect(getComputedStyle(area).display).toBe('none');

    // Store updates may recreate metadata without changing the automatic-embed setting.
    plugin.update(value => ({ ...value }));
    flushSync();
    expect(getComputedStyle(area).display).toBe('none');

    button(target, 'Show Image').click();
    flushSync();
    expect(getComputedStyle(area).display).not.toBe('none');

    plugin.update(value => ({ ...value, visible: false }));
    flushSync();
    expect(getComputedStyle(area).display).toBe('none');
    button(target, 'Show Image').click();
    flushSync();
    expect(getComputedStyle(area).display).not.toBe('none');
    button(target, 'Hide Image').click();
    flushSync();
    expect(getComputedStyle(area).display).toBe('none');

    plugin.update(value => ({ ...value, visible: true }));
    flushSync();
    expect(getComputedStyle(area).display).not.toBe('none');
});
