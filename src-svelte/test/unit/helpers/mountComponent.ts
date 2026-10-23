import { flushSync, mount, unmount } from 'svelte';
import type { Component } from 'svelte';

/**
 * The mount harness every component test was writing by hand.
 *
 * `mount` returns an owner object rather than a component instance, and Svelte 5
 * only runs an effect once the flush that follows it happens — so a test that
 * mounts without `flushSync` sees an empty target, and a test that mounts without
 * keeping the owner leaks the component and its effects into the next test. Both
 * mistakes look like a broken component rather than a missing line, which is why
 * the harness owns them instead of each file restating them.
 *
 * `teardown()` is for `afterEach`: it unmounts everything this harness mounted,
 * in case the test forgot to, and clears `document.body` so a later test cannot
 * query a node an earlier one left behind.
 */
export interface MountHarness {
    render: <Props extends Record<string, unknown>>(component: Component<Props>, props: Props) => HTMLElement;
    teardown: () => Promise<void>;
    unmountLast: () => Promise<void>;
}

export function mountHarness(): MountHarness {
    const mounted: Record<string, unknown>[] = [];

    function render<Props extends Record<string, unknown>>(component: Component<Props>, props: Props): HTMLElement {
        const target = document.createElement('div');
        document.body.appendChild(target);
        mounted.push(mount(component, { target, props }));
        flushSync();
        return target;
    }

    async function teardown(): Promise<void> {
        for (const component of mounted.splice(0)) await unmount(component);
        document.body.replaceChildren();
    }

    /**
     * Unmount only the most recently mounted component.
     *
     * A few tests unmount mid-test on purpose — to watch what the component does
     * when its owner is gone — and need that one component torn down while the
     * rest of the harness stays mounted.
     */
    async function unmountLast(): Promise<void> {
        const component = mounted.pop();
        if (component) await unmount(component);
    }

    return { render, teardown, unmountLast };
}
