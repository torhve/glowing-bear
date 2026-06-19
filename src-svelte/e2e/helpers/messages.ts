import { Page } from '@playwright/test';
import { irc } from './irc-control';

export async function sendMessage(page: Page, message: string) {
  const input = page.getByTestId('message-input');
  await input.fill(message);
  await input.press('Enter');
}

// sends a message from ggbbot to the channel #glowing-bear
export async function botSay(text: string) {
  await irc.sendMessage('#glowing-bear', text);
}

// sends a message from ggbbot to the channel #glowing-bear
export async function botNotice(text: string) {
  await irc.sendNotice('#glowing-bear', text);
}

// sends a message from ggbbot to the channel #glowing-bear
export async function botSayColored(text: string, fg?: string, bg?: string) {
  await irc.sendColored('#glowing-bear', text, fg, bg);
}

//sends a PM (IRC PRIVMSG) from gbbot to testuser on weechat relay
export async function botPm(text: string) {
  await irc.sendPm('testuser', text);
}
