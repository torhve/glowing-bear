import { describe, it, expect } from 'vitest';
import { hasUnread } from '$lib/utils';
import type { BufferData } from '$lib/types';

function createBuffer(opts: Partial<BufferData> = {}): BufferData {
    return {
        id: opts.id || 'test-buffer',
        fullName: opts.fullName || '#test',
        shortName: opts.shortName || '#test',
        hidden: false,
        trimmedName: null,
        nameClasses: [],
        prefix: '',
        number: 1,
        title: [],
        rtitle: '',
        lines: [],
        requestedLines: 0,
        allLinesFetched: true,
        lastSeen: Date.now(),
        unread: 0,
        notification: 0,
        notify: 0,
        nicklist: {},
        serverSortKey: '',
        indent: false,
        bufferType: 0,
        type: 'buffer' as any,
        plugin: '',
        server: '',
        hideBufferLineTimes: false,
        pinned: false,
        active: false,
        ...opts,
    };
}

describe('hasUnread filter', () => {
    it('returns true when unread > 0', () => {
        const buffer = createBuffer({ unread: 5 });
        expect(hasUnread(buffer)).toBe(true);
    });

    it('returns true when notification > 0', () => {
        const buffer = createBuffer({ notification: 3 });
        expect(hasUnread(buffer)).toBe(true);
    });

    it('returns true when both unread and notification > 0', () => {
        const buffer = createBuffer({ unread: 2, notification: 1 });
        expect(hasUnread(buffer)).toBe(true);
    });

    it('returns false when unread = 0 and notification = 0', () => {
        const buffer = createBuffer({ unread: 0, notification: 0 });
        expect(hasUnread(buffer)).toBe(false);
    });

    it('returns false when unread = 0 but notification = 0', () => {
        const buffer = createBuffer();
        expect(hasUnread(buffer)).toBe(false);
    });
});
