import { describe, it, expect, beforeEach } from 'vitest';
import { Protocol as NewProtocol, rawText2Rich } from '$lib/weechat';

async function loadOldProtocol() {
    const mod = await import('../fixtures/weechat-old.js');
    return (mod as unknown as { Protocol: typeof NewProtocol }).Protocol;
}

describe('debug parity 5', () => {
    let OldProtocol: typeof NewProtocol | null = null;
    
    beforeEach(async () => {
        if (!OldProtocol) {
            try {
                OldProtocol = await loadOldProtocol();
            } catch {
                OldProtocol = null;
            }
        }
    });

    it('\x19*03bold red\x1c', async () => {
        expect(OldProtocol).not.toBeNull();
        const input = '\x19*03bold red\x1c';
        const newResult = rawText2Rich(input);
        const oldResult = OldProtocol!.rawText2Rich(input);
        
        console.log('NEW parts:', newResult.length, 'OLD parts:', oldResult.length);
        for (let i = 0; i < Math.max(newResult.length, oldResult.length); i++) {
            const n = newResult[i];
            const o = oldResult[i];
            if (!n || !o) { console.log(`[${i}] missing part`, n ? '' : 'new', o ? '' : 'old'); continue; }
            console.log(`[${i}] NEW:`, JSON.stringify({ text: n.text, fgColor: n.fgColor, bgColor: n.bgColor, attrs: n.attrs }));
            console.log(`[${i}] OLD:`, JSON.stringify({ text: o.text, fgColor: o.fgColor, bgColor: o.bgColor, attrs: o.attrs }));
        }
        expect(true).toBe(true);
    });
});
