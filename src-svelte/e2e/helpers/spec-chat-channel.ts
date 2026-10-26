import type { Page } from '@playwright/test';
import { switchToBuffer, waitForBuffer } from './buffers';
import { irc } from './irc-control';
import { closeFixtureQueryBuffers, fixtureCommand } from './relay-admin';
import { botPm } from './messages';
import { waitForBotNickApplied } from './waits';

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

/**
 * Give the calling spec a private (query) buffer whose name it can assert on.
 *
 * Why this is needed: a WeeChat query buffer is named when it is created, by the peer's nick at
 * that moment, and a later nick change does not rename it. Measured with a scratch probe — the bot
 * was renamed to a fresh nick, the change was confirmed by a channel line carrying the new prefix,
 * a PM was sent under the new nick, and the sidebar still held the row named for the *old* nick
 * while the wait for the new name timed out. So `waitForBuffer('gbbot2')` is only reliable when a
 * buffer of that name already exists, which is fixture history and not anything the app did: half
 * the suite's specs were waiting for `gbbot` and the other half for `gbbot2`, on one shared buffer
 * whose name the first spec of the run happened to choose.
 *
 * The arrangement removes the inheritance. The fixture's query buffers are closed, the bot is
 * renamed to the nick this spec will assert on, the rename is confirmed through a channel line
 * (the relay sends no nicklist diff for the bot's own NICK, so the prefix a probe line is stored
 * under is what proves it landed), and a PM is sent so WeeChat creates the buffer under that nick.
 */
export async function openSpecPrivateBuffer(page: Page, nick: string, label: string): Promise<string> {
    await closeFixtureQueryBuffers();
    await irc.botNick(nick);
    await switchToBuffer(page, '#glowing-bear');
    await waitForBotNickApplied(page, nick, '#glowing-bear', `${label}-nick`);
    await botPm(`${label}-open-${Date.now()}`);

    const fullName = `irc.gbtest.${nick}`;
    try {
        await waitForBuffer(page, nick, 20000);
    } catch (error) {
        throw new Error(
            `openSpecPrivateBuffer(${label}): ${fullName} never appeared — ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
        );
    }
    return fullName;
}

/** Remove the private buffer a spec opened. As with a channel, only an exact close removes it. */
export function closeSpecPrivateBuffer(nick: string): void {
    fixtureCommand(`buffer close irc.gbtest.${nick}`);
}
