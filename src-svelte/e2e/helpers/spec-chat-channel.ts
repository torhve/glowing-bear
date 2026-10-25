import type { Page } from '@playwright/test';
import { switchToBuffer, waitForBuffer } from './buffers';
import { irc } from './irc-control';
import { fixtureCommand } from './relay-admin';

/**
 * Join a chat buffer the calling spec owns outright, and return its name.
 *
 * Why a spec needs its own channel: the scroll specs plant 30-line batches until the chat container
 * has a real scroll range, and `#glowing-bear` is the channel a dozen other serial specs join and
 * count rows in. Depth created there is depth every later spec in the same worker inherits, which is
 * exactly the coupling a passing run cannot see. A channel named here is unique per run, planted in
 * by one spec, and closed by exact name afterwards, so the arrangement a scroll assertion is made
 * against belongs to the spec that asserts on it.
 *
 * The join goes through the app's composer rather than the fixture's FIFO because WeeChat refuses
 * `/join` in the core buffer, and the FIFO always runs in core context. The bot joins the channel on
 * the mock IRC server first, so the channel exists there and the lines the spec later sends have
 * somewhere to go.
 */
export async function openSpecChatChannel(page: Page, label: string): Promise<string> {
    const name = `#gbown${label}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

    await irc.botJoin(name);

    const input = page.getByTestId('message-input');
    await switchToBuffer(page, '#glowing-bear');
    await input.click();
    await input.fill(`/join ${name}`);
    await input.press('Enter');

    // `/join` answers 204 on the relay; the buffer appearing is what proves it took. The channel
    // name is restated on failure because a setup failure should say which buffer this spec tried
    // to own, not only which buffers the sidebar happened to have.
    try {
        await waitForBuffer(page, name, 20000);
    } catch (error) {
        throw new Error(
            `openSpecChatChannel(${label}): ${name} never appeared — ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
        );
    }
    return name;
}

/**
 * Remove the channel a spec opened. `/part` leaves the buffer joined on this relay — only an exact
 * `buffer close` removes it — so leaving is not cleanup here.
 */
export function closeSpecChatChannel(name: string): void {
    fixtureCommand(`buffer close irc.gbtest.${name}`);
}
