import { describe, it, expect } from 'vitest';
import { formatBytes } from '#lib/format.ts';

/**
 * The connection-stats popover and the image upload preview used to carry their
 * own byte formatter and disagreed at megabytes — two decimals against one. One
 * decimal is now canonical, so the popover reads `12.3 MB` where it read
 * `12.34 MB`. That is the one rendered string this change moved, and it is
 * pinned here rather than left to review by eye.
 */
describe('formatBytes', () => {
    it('shows bytes below one kilobyte without a decimal', () => {
        expect(formatBytes(0)).toBe('0 B');
        expect(formatBytes(512)).toBe('512 B');
        expect(formatBytes(1023)).toBe('1023 B');
    });

    it('advances to kilobytes at exactly 1024', () => {
        expect(formatBytes(1024)).toBe('1.0 KB');
        expect(formatBytes(4300)).toBe('4.2 KB');
    });

    it('advances to megabytes at exactly 1024 kilobytes', () => {
        expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    });

    it('uses one decimal at megabytes, which is the change', () => {
        // 12.339… MB. The connection-stats copy rendered this as "12.34 MB".
        expect(formatBytes(12_932_106)).toBe('12.3 MB');
    });

    it('has no gigabyte tier', () => {
        expect(formatBytes(1024 * 1024 * 1024)).toBe('1024.0 MB');
    });
});
