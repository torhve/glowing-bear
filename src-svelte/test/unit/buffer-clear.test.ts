import { describe, it, expect } from 'vitest';

describe('/buffer clear command detection', () => {
    it('matches /buffer clear exactly', () => {
        const regex = /^\/buffer\s+clear\s*$/i;
        expect(regex.test('/buffer clear')).toBe(true);
    });

    it('matches /buffer clear with trailing whitespace', () => {
        const regex = /^\/buffer\s+clear\s*$/i;
        expect(regex.test('/buffer clear  ')).toBe(true);
    });

    it('matches /BUFFER CLEAR case-insensitively', () => {
        const regex = /^\/buffer\s+clear\s*$/i;
        expect(regex.test('/BUFFER CLEAR')).toBe(true);
    });

    it('does not match /buffer list', () => {
        const regex = /^\/buffer\s+clear\s*$/i;
        expect(regex.test('/buffer list')).toBe(false);
    });

    it('does not match /buffer', () => {
        const regex = /^\/buffer\s+clear\s*$/i;
        expect(regex.test('/buffer')).toBe(false);
    });

    it('does not match /buffer clearall', () => {
        const regex = /^\/buffer\s+clear\s*$/i;
        expect(regex.test('/buffer clearall')).toBe(false);
    });

    it('does not match message starting with /buffer clear', () => {
        const regex = /^\/buffer\s+clear\s*$/i;
        expect(regex.test('/buffer clear this message')).toBe(false);
    });

    it('matches /buffer\tclear with tab', () => {
        const regex = /^\/buffer\s+clear\s*$/i;
        expect(regex.test('/buffer\tclear')).toBe(true);
    });
});
