import { Browser, BrowserContext, Page, Route } from '@playwright/test';
import { connectToWeechat, clearSettings, waitForAppReady } from '../helpers/connection';
import { setupEffectOrphanFilter } from '../helpers/pageerror';

export interface CreateConnectedPageOptions {
  /** Settings to apply after clearing localStorage (e.g. { savepassword: false, enableEmojify: true }) */
  settings?: Record<string, unknown>;
  /** Block KaTeX CDN requests (default: true) */
  blockCdn?: boolean;
  /** Script to run before any page JS (e.g. to mock browser APIs) */
  initScript?: string | (() => string | void);
  /** Extra async setup after the page is ready but before connect (e.g. inject swipe helpers) */
  beforeConnect?: (page: Page) => Promise<void>;
}

/** Creates a new page, navigates to app, clears settings, and connects to WeeChat.
 *  Accepts either a Browser (creates a new context) or an existing BrowserContext.
 *  setupEffectOrphanFilter is baked in — callers no longer need to import it.
 *  CDN blocking is on by default. */
export async function createConnectedPage(
    browserOrContext: Browser | BrowserContext,
    options?: CreateConnectedPageOptions,
): Promise<Page> {
    const isBrowser = 'newContext' in browserOrContext;
    const ctx = isBrowser
        ? await (browserOrContext as Browser).newContext()
        : browserOrContext;
    const page = await ctx.newPage();

    if (options?.initScript) {
        await page.addInitScript(options.initScript);
    }

    if (options?.blockCdn !== false) {
        await page.route('**/cdnjs.cloudflare.com/**', (route: Route) => route.abort());
    }

    await page.goto('http://localhost:8001/');
    await waitForAppReady(page);
    setupEffectOrphanFilter(page);
    await clearSettings(page);

    if (options?.settings) {
        await page.evaluate(
            (s: Record<string, unknown>) => (window as any).__setGbSettings?.(s),
            options.settings,
        );
    }

    if (options?.beforeConnect) {
        await options.beforeConnect(page);
    }

    await connectToWeechat(page);
    return page;
}
