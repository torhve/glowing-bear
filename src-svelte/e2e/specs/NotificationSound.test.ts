import { test, expect } from '@playwright/test';
import { setSettings, reconnect } from '../helpers/connection';
import { waitForBuffer, switchToBuffer, bufferItemForName } from '../helpers/buffers';
import { irc } from '../helpers/irc-control';
import { closeSpecPrivateBuffer, openSpecPrivateBuffer } from '../helpers/spec-chat-channel';

import { createConnectedPage } from '../fixtures/auth';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser, {
        initScript: () => {
             
            (window as any).__audioCalls = [];
             
            const OrigAudio = (window as any).Audio || function () {};
             
            (window as any).Audio = function (src: unknown) {
                 
                (window as any).__audioCalls.push(src);
                return new OrigAudio(src);
            };
             
            (window as any).Audio.prototype.play = function () {};
             
            (window as any).Audio.prototype.pause = function () {};

            // Force document.hidden = true so playNotificationSound triggers in headless
            try { Object.defineProperty(document, 'hidden', { value: true, writable: false, configurable: true }); } catch { /* noop */ }

            // Mock playNotificationSound to log and call Audio
             
            (window as any).__playNotificationSound = function () {
                 
                (window as any).__audioCalls.push('playNotificationSound');
                console.log('[notification] playing notification sound');
            };
        },
        settings: { savepassword: false, autoconnect: false, soundnotification: true },
    });

    // Each test sends a PM while the chat looks at a channel and then proves the line landed
    // through the unread badge on the private buffer's own row. That row is named when WeeChat
    // creates the buffer, so the buffer is created here, under a nick this spec chose, instead of
    // being inherited from whatever private buffer the fixture happened to hold.
    await openSpecPrivateBuffer(page, 'gbbot2', 'notifsound');
});

test.afterAll(async () => {
    closeSpecPrivateBuffer('gbbot2');
    await page.close();
});

test.beforeEach(async () => {
    await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        w.__audioCalls = [];
    });
});

async function getAudioCalls(p: import('@playwright/test').Page): Promise<string[]> {
    return await p.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        return (w.__audioCalls as string[]) || [];
    });
}



const SOUND_ASSET = '/assets/audio/sonar.mp3';

/**
 * Every invocation of the app's own `playNotificationSound`, read out of the counter the function
 * keeps for itself (notifications.ts). It is recorded before the setting is consulted, so it says
 * the notify rule fired — not whether anything was allowed to play.
 */
function soundCalls(p: import('@playwright/test').Page): Promise<string[]> {
    return p.evaluate(() => ((window as any).__playNotificationSoundCalls as string[]) ?? []);
}

function resetSoundCounters(p: import('@playwright/test').Page) {
    return p.evaluate(() => {
        (window as any).__audioCalls = [];
        (window as any).__playNotificationSoundCalls = [];
    });
}

/** The Audio constructors the page recorded, for this notification's asset only. */
function builtSounds(p: import('@playwright/test').Page): Promise<string[]> {
    return getAudioCalls(p).then((calls) => calls.filter((src) => src === SOUND_ASSET));
}

/**
 * Send the app a private message while the chat is looking at another buffer — the case the sound
 * rule exists for — and then prove the line landed, through the unread badge on the query buffer's
 * own sidebar row. Without that second half, a message that never arrived and a sound that was
 * correctly withheld are the same observation.
 */
async function pmElsewhere(p: import('@playwright/test').Page, text: string) {
    await irc.sendPm('testuser', text);
    await expect(
        bufferItemForName(p, 'gbbot2').getByTestId('unread-badge'),
    ).toBeVisible({ timeout: 20000 });
}

test('a private message on a buffer the chat is not looking at plays the sound', async () => {
    await reconnect(page, { extraSettings: { soundnotification: true } });
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await resetSoundCounters(page);

    await pmElsewhere(page, `sound probe ${Date.now()}`);

    // The rule fired, and an Audio for the notification asset was actually constructed.
    await expect(async () => {
        expect(await soundCalls(page)).not.toHaveLength(0);
    }).toPass({ timeout: 15000, intervals: [250] });
    await expect(async () => {
        expect(await builtSounds(page)).toContain(SOUND_ASSET);
    }).toPass({ timeout: 10000, intervals: [250] });
});

// The test here used to be "sound does not play when soundnotification is disabled", and it was
// not a check: it switched to #glowing-bear (so any message there is in the buffer being looked at
// and owes no sound anyway), sent a PM addressed to `gbbot` — a nick no client on this fixture has
// — and asserted that nothing had been constructed. A message that never arrived and a sound that
// was correctly withheld produced the same result. Both halves are now measured.
test('the same message plays nothing while the sound setting is off', async () => {
    await reconnect(page, { extraSettings: { soundnotification: false } });
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await resetSoundCounters(page);

    await pmElsewhere(page, `silent probe ${Date.now()}`);

    // The notify rule fired for the very same message. That is the half that makes the next
    // assertion mean something: what is missing is the Audio, because the setting says so.
    await expect(async () => {
        expect(await soundCalls(page)).not.toHaveLength(0);
    }).toPass({ timeout: 15000, intervals: [250] });

    // One more line through the same path, this time in the buffer the chat is looking at, so the
    // emptiness below is a settled state and not a race that has not landed yet.
    const stamp = `while-looking-here ${Date.now()}`;
    await irc.sendMessage('#glowing-bear', stamp);
    await expect(
        page.getByTestId('bufferline-row').filter({ hasText: stamp }).first(),
    ).toBeVisible({ timeout: 20000 });

    expect(await builtSounds(page), 'a sound was built while the setting said not to').toHaveLength(0);
});

test('sound setting toggle persists', async () => {
    // Re-enable soundnotification (was disabled by previous test)
    await setSettings(page, { soundnotification: true });
    await reconnect(page);
    await waitForBuffer(page, '#glowing-bear', 10000);
    await switchToBuffer(page, '#glowing-bear');

    await page.getByTestId('settings-button').click();
    await expect(page.getByTestId('settings-modal')).toBeVisible({ timeout: 5000 });

    const checkbox = page.getByTestId('sound-checkbox');
    await expect(checkbox).toBeChecked();

    await checkbox.uncheck();
    await expect(checkbox).not.toBeChecked();

    await page.getByTestId('settings-modal-close').click();
    await expect(page.getByTestId('settings-modal')).not.toBeVisible({ timeout: 5000 });

    // Reopen and verify
    await page.getByTestId('settings-button').click();
    await expect(page.getByTestId('settings-modal')).toBeVisible({ timeout: 5000 });
    await expect(checkbox).not.toBeChecked();
    await page.getByTestId('settings-modal-close').click();
});
