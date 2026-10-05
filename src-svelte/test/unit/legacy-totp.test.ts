import { describe, expect, it, vi } from 'vitest';
import { resolveTotpCode } from '#lib/stores/legacyConnection.ts';

// The legacy relay carries TOTP in-band (init totp=...), so the browser can
// satisfy a TOTP-required relay — unlike the API path. These tests pin the
// prompt decision itself; the wire serialization is covered in protocol.test.ts.
describe('resolveTotpCode (legacy in-band TOTP prompt)', () => {
    it('returns null without prompting when the relay does not request TOTP', () => {
        const prompt = vi.fn();
        expect(resolveTotpCode({ totp: 'off' }, prompt)).toBeNull();
        expect(resolveTotpCode({}, prompt)).toBeNull();
        expect(resolveTotpCode(undefined, prompt)).toBeNull();
        expect(prompt).not.toHaveBeenCalled();
    });

    it('prompts and returns the entered code when the relay requests TOTP', () => {
        const prompt = vi.fn(() => '123456');
        expect(resolveTotpCode({ totp: 'on' }, prompt)).toBe('123456');
        expect(prompt).toHaveBeenCalledWith('Please enter your TOTP Token');
    });

    it('sends no code when the prompt is cancelled or left empty', () => {
        expect(resolveTotpCode({ totp: 'on' }, () => null)).toBeNull();
        expect(resolveTotpCode({ totp: 'on' }, () => '')).toBeNull();
        expect(resolveTotpCode({ totp: 'on' }, () => '   ')).toBeNull();
    });

    it('trims surrounding whitespace from the entered code', () => {
        expect(resolveTotpCode({ totp: 'on' }, () => ' 42 42 ')).toBe('42 42');
    });
});
