import { test as base, Page } from '@playwright/test';
import { connectToWeechat, clearSettings } from '../helpers/connection';

export const test = base.extend<{ authedPage: Page }>({
  authedPage: async ({ browser }, use) => {
    const page = await browser.newPage();
    await clearSettings(page);
    await page.goto('/');
    await connectToWeechat(page);
    await use(page);
    await page.close();
  },
});
