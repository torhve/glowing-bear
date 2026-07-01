import { Page } from '@playwright/test';

export async function fillInput(page: Page, testId: string, text: string) {
  await page.getByTestId(testId).fill(text);
}
