// The content-search wait must resolve on the first fresh buffer change, not on
// a fixed sleep, and must not leave a timer or a subscription behind.
import { describe, it, expect, vi } from 'vitest';
import { get } from 'svelte/store';
import { buffers } from '#lib/stores/models.ts';
import { captureBufferAppearance, waitForFreshBuffer, scriptInstalled } from '#lib/utils.ts';
import type { BufferData } from '#lib/types.ts';

const GREP = 'grep';

function grepBuffer(id: string, clearEpoch: number): BufferData {
    return {
        id,
        fullName: 'python.grep',
        shortName: GREP,
        hidden: false,
        trimmedName: null,
        nameClasses: [],
        prefix: '',
        number: 3,
        title: [],
        rtitle: '',
        lines: [],
        requestedLines: 0,
        allLinesFetched: true,
        lastSeen: -1,
        localUnread: 0,
        unread: 0,
        notification: 0,
        bufferType: 1,
        nicklist: {},
        nicklistSize: 0,
        clearEpoch,
    } as BufferData;
}

function showGrep(id: string, clearEpoch: number) {
    buffers.set({ [id]: grepBuffer(id, clearEpoch) });
}

describe('content-search buffer wait', () => {
    it('resolves immediately when the buffer was opened by the search', async () => {
        vi.useFakeTimers();
        const before = captureBufferAppearance(GREP); // no grep buffer yet
        showGrep('grep-id', 1);

        const id = await waitForFreshBuffer(GREP, before, 3000);

        expect(id).toBe('grep-id');
        // The timeout was cleared, so no timer survives the resolution.
        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
    });

    it('resolves when an existing buffer is cleared by a new search', async () => {
        vi.useFakeTimers();
        showGrep('grep-id', 1);
        const before = captureBufferAppearance(GREP);

        const pending = waitForFreshBuffer(GREP, before, 3000);
        await vi.advanceTimersByTimeAsync(500);
        showGrep('grep-id', 2); // clearEpoch bump = a fresh /grep run

        expect(await pending).toBe('grep-id');
        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
    });

    it('does not resolve for an untouched pre-existing buffer', async () => {
        vi.useFakeTimers();
        showGrep('grep-id', 1);
        const before = captureBufferAppearance(GREP);

        const pending = waitForFreshBuffer(GREP, before, 3000);
        // A buffer that only re-renders the same rows is stale, not a result.
        showGrep('grep-id', 1);
        await vi.advanceTimersByTimeAsync(3000);

        expect(await pending).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
    });

    it('waits for a newly opened buffer even while another one exists', async () => {
        vi.useFakeTimers();
        showGrep('old-grep', 1);
        const before = captureBufferAppearance(GREP);

        const pending = waitForFreshBuffer(GREP, before, 3000);
        await vi.advanceTimersByTimeAsync(200);
        buffers.set({ 'new-grep': grepBuffer('new-grep', 7) });

        expect(await pending).toBe('new-grep');
        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
    });

    it('reports script presence from the file names the relay returns', () => {
        expect(scriptInstalled(['grep.py', 'weechat-python.py'], 'grep')).toBe(true);
        expect(scriptInstalled(['other.py'], 'grep')).toBe(false);
        expect(scriptInstalled(null, 'grep')).toBeNull();
    });
});
