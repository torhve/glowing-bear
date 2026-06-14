import { Page } from '@playwright/test';

export async function openSettings(page: Page) {
  await page.getByTestId('settings-button').click();
  await page.getByTestId('settings-modal').waitFor({ state: 'visible' });
}

export async function closeSettings(page: Page) {
  await page.getByTestId('settings-modal-close').click();
  await page.getByTestId('settings-modal').waitFor({ state: 'hidden' });
}
