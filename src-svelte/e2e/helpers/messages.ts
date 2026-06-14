import { Page } from '@playwright/test';
import { irc } from './irc-control';

export async function sendMessage(page: Page, message: string) {
  const input = page.getByTestId('message-input');
  await input.fill(message);
  await input.press('Enter');
}

export async function botSay(text: string) {
  await irc.sendMessage('#glowing-bear', text);
}

export async function botNotice(text: string) {
  await irc.sendNotice('#glowing-bear', text);
}

export async function botSayColored(text: string, fg?: string, bg?: string) {
  await irc.sendColored('#glowing-bear', text, fg, bg);
}

export async function botPm(text: string) {
  await irc.sendPm('testuser', text);
}

export async function assertLastMessage(page: Page, text: string) {
  const lastRow = page.locator('[data-testid="bufferline-row"]').last();
  await expect(lastRow.locator('.message')).toContainText(text);
}
