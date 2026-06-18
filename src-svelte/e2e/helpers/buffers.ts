import { Page } from '@playwright/test';

// Buffer list displays trimmedName (stripped of #, &, etc.), so match against that.
function getBufferText(name: string): string {
  return name.replace(/^[#&!+@]+/, '');
}

export async function waitForBuffer(page: Page, name: string, timeout = 10000) {
  await page.getByTestId('buffer-item')
    .filter({ hasText: getBufferText(name) })
    .first()
    .waitFor({ state: 'visible', timeout });
}

export async function switchToBuffer(page: Page, name: string) {
  await page.getByTestId('buffer-item')
    .filter({ hasText: getBufferText(name) })
    .first()
    .click();
  await page.waitForTimeout(500);
}
