/**
 * A derived store that publishes only when its value actually changed.
 *
 * Svelte cannot do this itself for objects or arrays: `safe_not_equal`
 * (node_modules/svelte/src/internal/client/reactivity/equality.js) reports every
 * non-null object as unequal, *including the identical reference*, so a derived
 * whose value is an object notifies on every recompute. For a string or a number
 * Svelte's own comparison is already correct — which is why the selective
 * `currentBuffer` works by publishing a numeric revision.
 *
 * Anything else needs an explicit comparison, and the store components subscribe
 * to has to be the one that stays quiet.
 *
 * The inner derived is subscribed here rather than left lazy: a Svelte derived
 * only computes while something is subscribed to it, and nothing downstream
 * subscribes to it — only to `out`. Leaving it lazy means it never runs.
 */
import { derived, get, writable } from 'svelte/store';

export function selectiveDerived<T>(
    deps: unknown[],
    compute: () => T,
    same: (a: T, b: T) => boolean,
): { subscribe: (run: (value: T) => void) => () => void } {
    const out = writable<T>(compute());
    derived(deps as never, () => compute()).subscribe((next) => {
        if (!same(get(out), next)) out.set(next);
    });
    return {
        subscribe: (run: (value: T) => void) => {
            const unsub = out.subscribe(run);
            return () => {
                unsub();
            };
        },
    };
}

/** Element-wise identity comparison for arrays of interned objects. */
export function sameArrayByReference<T>(a: T[], b: T[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}
