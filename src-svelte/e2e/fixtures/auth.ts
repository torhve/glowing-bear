import { Browser, Page } from '@playwright/test';
import { connectToWeechat, clearSettings, waitForAppReady } from '../helpers/connection';

/** Creates a new page, navigates to app, clears settings, and connects to WeeChat.
 *  Also blocks unnecessary external resources (KaTeX CDN) to speed up page loads. */
export async function createConnectedPage(browser: Browser): Promise<Page> {
    const page = await browser.newPage();
    await page.route('**/cdnjs.cloudflare.com/**', route => route.abort());
    await page.goto('/');
    await waitForAppReady(page);
    await clearSettings(page);
    await connectToWeechat(page);
    return page;
}
