// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { applyHashParams } from '#lib/stores/settings.ts';

// Runs with no DOM at all, which is what the `typeof window === 'undefined'` guard
// in applyHashParams is actually protecting against. jsdom's `window` is a
// non-configurable global, so it cannot be removed from a jsdom test.
describe('applyHashParams in a server environment', () => {
    it('has no window', () => {
        expect(typeof window).toBe('undefined');
    });

    it('does not read hash params or throw', () => {
        expect(() => applyHashParams()).not.toThrow();
    });
});
