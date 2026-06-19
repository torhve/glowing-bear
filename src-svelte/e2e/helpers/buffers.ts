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

// On mobile viewports the buffer list hides after selection. This variant
// temporarily widens the viewport so the buffer list shows, switches buffers,
// then restores the original viewport size. After restoring, it calls
// hideBufferListOnMobile so the buffer list hides on mobile as expected.
export async function switchToBufferMobile(page: Page, name: string) {
  const orig = await page.viewportSize() || { width: 375, height: 667 };
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await page.waitForTimeout(300);
  await switchToBuffer(page, name);
  // Restore mobile viewport first so isMobile() returns true
  await page.setViewportSize(orig);
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await page.waitForTimeout(200);
  // Now hideBufferListOnMobile will actually set showBufferList = false
  await page.evaluate(() => (window as any).__hideBufferListOnMobile?.());
  await page.waitForTimeout(300);
}

// Like waitForBuffer but safe for mobile: widens viewport so the buffer list
// shows, waits for the buffer to appear, then restores the original viewport.
export async function waitForBufferMobile(page: Page, name: string, timeout = 10000) {
  const orig = await page.viewportSize() || { width: 375, height: 667 };
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await page.waitForTimeout(300);
  await waitForBuffer(page, name, timeout);
  await page.setViewportSize(orig);
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await page.waitForTimeout(300);
}
