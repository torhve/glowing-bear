/**
 * E2E performance benchmark: initial app load + first connect.
 *
 * Fresh page (no cache) → goto → fill connection form → connect →
 * chat view visible. Measures the user-facing "open the app" latency.
 *
 * Run with:
 *   npx playwright test --config src-svelte/e2e/playwright.bench.config.ts -g "load:"
 */
import { test, expect } from '@playwright/test';
import { fillInput } from '../helpers/input';

test('load: fresh page to connected chat view', async ({ browser }) => {
    const page = await browser.newPage();
    try {
        const t0 = Date.now();
        await page.goto('http://localhost:8001/', { waitUntil: 'domcontentloaded' });
        const domAt = Date.now() - t0;

        await page.getByTestId('host-input').waitFor({ state: 'visible', timeout: 15000 });
        const formAt = Date.now() - t0;

        await fillInput(page, 'host-input', 'localhost');
        await fillInput(page, 'port-input', '9001');
        await fillInput(page, 'password-input', 'testpassword123');
        await page.getByTestId('connect-button').click();
        await page.getByTestId('chat-view').waitFor({ state: 'visible', timeout: 45000 });
        const chatAt = Date.now() - t0;

        // Buffers populated?
        const bufferCount = await page.locator('[data-testid="buffer-item"]').count();
        const rows = await page.locator('[data-testid="bufferline-row"]').count();

        console.log(
            `[bench] load: dom=${domAt}ms form=${formAt}ms chat-ready=${chatAt}ms ` +
            `connect-phase=${chatAt - formAt}ms buffers=${bufferCount} rows=${rows}`
        );
        expect(bufferCount).toBeGreaterThan(0);
    } finally {
        await page.close();
    }
}, 120000);
