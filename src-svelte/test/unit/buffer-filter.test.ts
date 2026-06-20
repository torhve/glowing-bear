import { describe, it, expect } from 'vitest';

interface TestBuffer {
    id: string;
    shortName: string;
    fullName: string;
    hidden: boolean;
    unread: number;
    notification: number;
    active: boolean;
    pinned: boolean;
}

function shouldShowInBufferList(
    buf: TestBuffer,
    onlyUnread: boolean,
    activeBufferId: string = ''
): boolean {
    if (buf.hidden) return false;
    return !onlyUnread || buf.unread > 0 || buf.notification > 0 || buf.id === activeBufferId || buf.pinned;
}

describe('Buffer List Filtering', () => {
    describe('when onlyUnread is false', () => {
        it('shows all non-hidden buffers regardless of unread/pinned status', () => {
            const emptyBuf: TestBuffer = { id: '1', shortName: '#empty', fullName: '#empty', hidden: false, unread: 0, notification: 0, active: false, pinned: false };
            const pinnedBuf: TestBuffer = { id: '2', shortName: '#pinned', fullName: '#pinned', hidden: false, unread: 0, notification: 0, active: false, pinned: true };
            expect(shouldShowInBufferList(emptyBuf, false)).toBe(true);
            expect(shouldShowInBufferList(pinnedBuf, false)).toBe(true);
        });

        it('hides buffers with hidden=true', () => {
            const hiddenBuf: TestBuffer = { id: '3', shortName: '#hidden', fullName: '#hidden', hidden: true, unread: 5, notification: 0, active: false, pinned: false };
            expect(shouldShowInBufferList(hiddenBuf, false)).toBe(false);
        });
    });

    describe('when onlyUnread is true', () => {
        it('shows buffers with unread > 0', () => {
            const buf: TestBuffer = { id: '1', shortName: '#test', fullName: '#test', hidden: false, unread: 1, notification: 0, active: false, pinned: false };
            expect(shouldShowInBufferList(buf, true, '2')).toBe(true);
        });

        it('shows buffers with notification > 0', () => {
            const buf: TestBuffer = { id: '1', shortName: '#test', fullName: '#test', hidden: false, unread: 0, notification: 1, active: false, pinned: false };
            expect(shouldShowInBufferList(buf, true, '2')).toBe(true);
        });

        it('shows the active buffer even with no unread/notification', () => {
            const buf: TestBuffer = { id: '1', shortName: '#idle', fullName: '#idle', hidden: false, unread: 0, notification: 0, active: true, pinned: false };
            expect(shouldShowInBufferList(buf, true, '1')).toBe(true);
        });

        it('shows pinned buffers even with no unread/notification/active', () => {
            const pinnedBuf: TestBuffer = { id: '1', shortName: '#pinned', fullName: '#pinned', hidden: false, unread: 0, notification: 0, active: false, pinned: true };
            expect(shouldShowInBufferList(pinnedBuf, true, '2')).toBe(true);
        });

        it('hides buffers with no unread/notification/active/pinned', () => {
            const buf: TestBuffer = { id: '1', shortName: '#idle', fullName: '#idle', hidden: false, unread: 0, notification: 0, active: false, pinned: false };
            expect(shouldShowInBufferList(buf, true, '2')).toBe(false);
        });

        it('hides buffer when activeBufferId points to a different buffer', () => {
            const buf: TestBuffer = { id: '1', shortName: '#idle', fullName: '#idle', hidden: false, unread: 0, notification: 0, active: false, pinned: false };
            expect(shouldShowInBufferList(buf, true, '3')).toBe(false);
        });

        it('still hides hidden buffers even if pinned', () => {
            const buf: TestBuffer = { id: '1', shortName: '#hidden-pinned', fullName: '#hidden-pinned', hidden: true, unread: 0, notification: 0, active: false, pinned: true };
            expect(shouldShowInBufferList(buf, true, '1')).toBe(false);
        });
    });
});
