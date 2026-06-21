import { Page } from '@playwright/test';

export async function openSettings(page: Page) {
  await page.getByTestId('settings-button').click();
  await page.getByTestId('settings-modal').waitFor({ state: 'visible' });
}

export async function closeSettings(page: Page) {
  const modal = page.getByTestId('settings-modal');
  if ((await modal.isVisible().catch(() => false))) {
    await page.getByTestId('settings-modal-close').click();
    await modal.waitFor({ state: 'hidden', timeout: 5000 });
  }
}
