import type { Page } from '@playwright/test';

/**
 * Suppress Svelte $effect_orphan errors in E2E tests.
 * These are harmless warnings from Svelte 5 during component teardown
 * and would otherwise cause Playwright tests to fail.
 */
export function setupEffectOrphanFilter(page: Page): void {
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
        if (error.message?.includes('Effect orphaned')) return;
    });
}
