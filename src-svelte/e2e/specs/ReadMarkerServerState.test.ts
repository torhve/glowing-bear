import { test, expect } from '@playwright/test';
import { pbkdf2Sync } from 'node:crypto';
import { createConnectedPage } from '../fixtures/auth';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';
import { irc } from '../helpers/irc-control';
import { setupEffectOrphanFilter } from '../helpers/pageerror';

// What WeeChat itself remembers after Glowing Bear switches to a buffer.
//
// Switching sends `/buffer set hotlist -1` and `/buffer set unread` to the relay, and
// those mutate shared server state: every other client sees the cleared hotlist entry
// and the moved read marker. The marker matters in a specific way — `/buffer set unread`
// (no argument) puts it on the buffer's last line, so `last_read_line_id` is a real line
// id, while `/buffer set unread 0` removes it and leaves -1, which is indistinguishable
// from "nothing has been read" unless the client also reads `first_line_not_read`.
//
// This asserts the server-side effect, not the rendered marker (ReadMarker.test.ts
// covers that), so a change to either command shows up here.

const API_PORT = 9010;
const PASSWORD = 'testpassword123';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    setupEffectOrphanFilter(page);
});

test.afterAll(async () => {
    await page.close();
});

function authHeader(): string {
    const timestamp = Math.floor(Date.now() / 1000);
    const iterations = 100000;
    const hash = pbkdf2Sync(PASSWORD, String(timestamp), iterations, 32, 'sha256').toString('hex');
    return 'Basic ' + Buffer.from(`hash:pbkdf2+sha256:${timestamp}:${iterations}:${hash}`).toString('base64');
}

async function relayJson(path: string): Promise<unknown> {
    const response = await fetch(`http://127.0.0.1:${API_PORT}${path}`, {
        headers: { Authorization: authHeader() },
    });
    if (!response.ok) throw new Error(`relay ${path} → ${response.status}`);
    return response.json();
}

async function bufferState(name: string) {
    const buffers = await relayJson('/api/buffers?columns=id,name,last_read_line_id,first_line_not_read') as Array<Record<string, unknown>>;
    const buffer = buffers.find((entry) => entry.name === name);
    if (!buffer) throw new Error(`buffer ${name} not found on the relay`);
    return {
        id: String(buffer.id),
        lastReadLineId: Number(buffer.last_read_line_id ?? -1),
        firstLineNotRead: buffer.first_line_not_read,
    };
}

async function hotlistIds(): Promise<string[]> {
    const hotlist = await relayJson('/api/hotlist?columns=buffer_id') as Array<Record<string, unknown>>;
    return Array.isArray(hotlist) ? hotlist.map((entry) => String(entry.buffer_id)) : [];
}

test('switching to a buffer leaves a real read marker on the relay', async () => {
    await waitForBuffer(page, '#glowing-bear', 20000);
    const name = 'irc.gbtest.#glowing-bear';
    const before = await bufferState(name);

    // Accumulate lines while another buffer is displayed, so the channel ends up with
    // lines newer than whatever marker WeeChat already holds.
    await switchToBuffer(page, 'gbtest');
    await irc.sendMessage('#glowing-bear', 'server marker probe 1');
    await irc.sendMessage('#glowing-bear', 'server marker probe 2');

    // WeeChat itself must see the channel as unread before the switch; otherwise the
    // marker check below could pass without the switch having done anything.
    await expect.poll(async () => (await hotlistIds()).includes(before.id), { timeout: 15000 }).toBe(true);

    await switchToBuffer(page, '#glowing-bear');

    // `/buffer set unread` (no argument) moves the marker onto the buffer's last line,
    // so it advances to a real line id. `/buffer set unread 0` would leave -1, which for a
    // client that does not also read first_line_not_read is indistinguishable from
    // "nothing has been read" — the exact ambiguity WeeChat added that field for.
    await expect.poll(async () => {
        const marker = (await bufferState(name)).lastReadLineId;
        return marker > 0 && marker > before.lastReadLineId;
    }, { timeout: 15000 }).toBe(true);

    // `/buffer set hotlist -1` removed this buffer from the hotlist every client shares.
    await expect.poll(async () => (await hotlistIds()).includes(before.id), { timeout: 15000 }).toBe(false);
});
