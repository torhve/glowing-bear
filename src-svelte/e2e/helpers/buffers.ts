import { Page, expect } from '@playwright/test';

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
  await expect(page.getByTestId('topic-bar')).toContainText(getBufferText(name), { timeout: 5000 });
}

// On mobile viewports the buffer list hides after selection. This variant
// temporarily widens the viewport so the buffer list shows, switches buffers,
// then restores the original viewport size. Since the buffer click happens
// at desktop viewport, hideBufferListOnMobile isn't triggered (it checks
// isMobileState). So we manually hide the buffer list after restoring mobile.
export async function switchToBufferMobile(page: Page, name: string) {
  const orig = await page.viewportSize() || { width: 375, height: 667 };
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await page.getByTestId('buffer-item').first().waitFor({ state: 'visible', timeout: 5000 });
  await switchToBuffer(page, name);
  // Restore mobile viewport — resize listener updates isMobileState
  // and may show buffer list on desktop→mobile transition.
  await page.setViewportSize(orig);
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  // Manually hide buffer list since the click happened at desktop viewport
  // where hideBufferListOnMobile wasn't triggered.
  await page.evaluate(() => (window as any).__hideBufferListOnMobile?.());
  await expect(page.getByTestId('buffer-list')).not.toBeAttached();
}

// Like waitForBuffer but safe for mobile: widens viewport so the buffer list
// shows, waits for the buffer to appear, then restores the original viewport.
export async function waitForBufferMobile(page: Page, name: string, timeout = 10000) {
  const orig = await page.viewportSize() || { width: 375, height: 667 };
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await page.getByTestId('buffer-item').first().waitFor({ state: 'visible', timeout: 5000 });
  await waitForBuffer(page, name, timeout);
  await page.setViewportSize(orig);
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
}
