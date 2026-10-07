import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { switchToBuffer } from '../helpers/buffers';
import { irc } from '../helpers/irc-control';
import { weechat5RelayInfo, WEECHAT5_RELAY_PORT } from '../helpers/weechat5';

/**
 * Contract coverage against a NEWER relay than gbtest.
 *
 * gbtest is pinned to WeeChat 4.10.1 / relay API 0.6.0 — the contract the app was
 * written against. Every relay-side change is therefore invisible to the suite
 * until a user hits it, and that is exactly how WeeChat 5.0's removal of
 * `date_printed` from the line object became "the chat is empty but connected":
 * the validator required the field, so every line — fetched history and live
 * `buffer_line_added` alike — was rejected and dropped.
 *
 * These tests run against the optional gbtest5 fixture (a WeeChat 5 relay sharing
 * gbtest's IRC server) and assert both halves of the contract:
 *   1. the relay really does omit the field — so the fixture cannot be silently
 *      satisfied by a 4.10.1 relay, and
 *   2. the app renders the line anyway, with no validation warnings.
 *
 * The fixture is optional: without a WeeChat 5 build the spec skips rather than
 * failing, so the main suite still runs on any machine.
 */

test.describe.configure({ mode: 'serial' });

const CHANNEL = '#glowing-bear';

let relayInfo: Awaited<ReturnType<typeof weechat5RelayInfo>> = null;

test.beforeAll(async () => {
    relayInfo = await weechat5RelayInfo();
    if (!relayInfo) {
        test.skip(true, 'no WeeChat 5 relay fixture — run test/fixtures/gbtest5/start.sh');
    }
});

interface Captured {
    page: import('@playwright/test').Page;
    frames: string[];
    warnings: string[];
}

/** Connect to the 5.0 relay and record what the relay actually put on the wire. */
async function connectAndWatch(browser: import('@playwright/test').Browser): Promise<Captured> {
    const captured: Captured = { page: null as never, frames: [], warnings: [] };
    captured.page = await createConnectedPage(browser, {
        port: String(WEECHAT5_RELAY_PORT),
        beforeConnect: (p) => {
            p.on('console', (msg) => {
                const text = msg.text();
                if (/\[api\] invalid|validation/i.test(text)) captured.warnings.push(text);
            });
            p.on('websocket', (ws) => {
                if (!ws.url().includes(`:${WEECHAT5_RELAY_PORT}`)) return;
                ws.on('framereceived', (f) => captured.frames.push(String(f.payload)));
            });
        },
    });
    return captured;
}

test('the 5.0 relay sends line objects with no date_printed, fetched history included', async ({ browser }) => {
    const { page, frames } = await connectAndWatch(browser);
    await switchToBuffer(page, CHANNEL);
    await expect.poll(async () =>
        page.locator('[data-testid="bufferline-row"]').count(), { timeout: 20000 }).toBeGreaterThan(0);

    // Parse rather than substring-match, and require real line objects: a frame
    // whose body is an empty array would satisfy a `toContain`-free assertion
    // while proving nothing was ever received.
    type LineFrame = { body_type?: string; body?: unknown };
    const linePayloads: Record<string, unknown>[] = [];
    for (const frame of frames) {
        let parsed: LineFrame;
        try { parsed = JSON.parse(frame) as LineFrame; } catch { continue; }
        if (parsed.body_type === 'line' && parsed.body && typeof parsed.body === 'object') {
            linePayloads.push(parsed.body as Record<string, unknown>);
        } else if (parsed.body_type === 'lines' && Array.isArray(parsed.body)) {
            linePayloads.push(...(parsed.body as Record<string, unknown>[]));
        }
    }
    expect(linePayloads.length, 'the app should have received line payloads from the 5.0 relay').toBeGreaterThan(0);

    // The premise of the whole test: this relay does not send the field. If a
    // 4.10.1 relay ever answered this port, this assertion fails instead of the
    // test quietly certifying 5.0 behaviour against the wrong server.
    for (const payload of linePayloads) {
        expect(Object.keys(payload), `line payload still carries date_printed: ${JSON.stringify(payload).slice(0, 200)}`)
            .not.toContain('date_printed');
    }
});

test('a live channel message from the 5.0 relay renders, with no dropped lines', async ({ browser }) => {
    const marker = `wc5-${Date.now().toString(36)}`;
    const { page, warnings } = await connectAndWatch(browser);
    await switchToBuffer(page, CHANNEL);

    await irc.sendMessage(CHANNEL, marker);

    await expect(page.getByText(marker, { exact: false }).first(),
        'a 5.0-shaped line must render, not be rejected by the validator')
        .toBeVisible({ timeout: 30000 });

    expect(warnings, `lines were rejected: ${warnings.slice(0, 2).join(' | ')}`).toEqual([]);
});
