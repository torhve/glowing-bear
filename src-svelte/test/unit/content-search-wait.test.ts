// The content-search wait must resolve on the first fresh buffer change, not on
// a fixed sleep, and must not leave a timer or a subscription behind.
import { describe, it, expect, vi } from 'vitest';
import { get } from 'svelte/store';
import { buffers, createBuffer } from '#lib/stores/models.ts';
import { captureBufferAppearance, waitForFreshBuffer, scriptInstalled } from '#lib/utils.ts';
import type { BufferData } from '#lib/types.ts';

const GREP = 'grep';

function grepBuffer(id: string, clearEpoch: number): BufferData {
    // `python.grep` reports no `type` local variable and buffer type 1 (a free
    // buffer); the search marks the buffer it opened as already fetched.
    const buffer = createBuffer({ pointers: [id], full_name: 'python.grep', short_name: GREP, number: 3, type: 1 });
    buffer.allLinesFetched = true;
    buffer.clearEpoch = clearEpoch;
    return buffer;
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

describe('overlapping searches', () => {
    it('resolves once, on the first fresh change', async () => {
        vi.useFakeTimers();
        showGrep('grep-id', 1);
        const before = captureBufferAppearance(GREP);

        const pending = waitForFreshBuffer(GREP, before, 3000);
        showGrep('grep-id', 2); // first /grep run clears the buffer
        showGrep('grep-id', 3); // a second run changes it while the wait is open

        // The wait must not resolve twice, and results arriving after the clear
        // still render because the buffer itself stays reactive.
        expect(await pending).toBe('grep-id');
        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
    });
});
