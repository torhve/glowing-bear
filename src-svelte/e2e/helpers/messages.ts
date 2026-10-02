import { Page, expect } from '@playwright/test';
import { irc } from './irc-control';

export async function sendMessage(page: Page, message: string) {
    const input = page.getByTestId('message-input');
    await input.fill(message);
    await input.press('Enter');
}

// sends a message from gbbot to the channel #glowing-bear
export async function botSay(text: string) {
    await irc.sendMessage('#glowing-bear', text);
}

// Send a channel message once and wait until the app actually renders it.
// Only the observation is retried (by waiting), never the delivery: re-sending
// would mask a dropped relay connection and could duplicate a line that other
// ordering and unread assertions depend on. A message that never arrives must
// fail the spec so the drop stays visible.
export async function botSayVisible(page: Page, text: string, timeout = 15000) {
    const row = page
        .locator('[data-testid="bufferline-row"] td.message')
        .filter({ hasText: text })
        .first();
    await irc.sendMessage('#glowing-bear', text);
    await expect(row, `gbbot message ${text} never reached the client`).toBeVisible({ timeout });
}

// sends a message from gbbot to the channel #glowing-bear
export async function botNotice(text: string) {
    await irc.sendNotice('#glowing-bear', text);
}

// sends a message from gbbot to the channel #glowing-bear
export async function botSayColored(text: string, fg?: string, bg?: string) {
    await irc.sendColored('#glowing-bear', text, fg, bg);
}

//sends a PM (IRC PRIVMSG) from gbbot to testuser on weechat relay
export async function botPm(text: string) {
    await irc.sendPm('testuser', text);
}
