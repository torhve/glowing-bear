import { describe, it, expect, beforeEach } from 'vitest';
import { Protocol as NewProtocol, rawText2Rich } from '$lib/weechat';

async function loadOldProtocol() {
    const mod = await import('../fixtures/weechat-old.js');
    return (mod as unknown as { Protocol: typeof NewProtocol }).Protocol;
}

describe('debug parity', () => {
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

    it('F*03 bold red text', async () => {
        expect(OldProtocol).not.toBeNull();
        const input = '\x19F*03bold red text';
        const newResult = rawText2Rich(input);
        const oldResult = OldProtocol!.rawText2Rich(input);
        
        console.log('=== NEW ===');
        for (const p of newResult) {
            console.log(JSON.stringify({ text: p.text, fgColor: p.fgColor, bgColor: p.bgColor, attrs: p.attrs }));
        }
        console.log('=== OLD ===');
        for (const p of oldResult) {
            console.log(JSON.stringify({ text: p.text, fgColor: p.fgColor, bgColor: p.bgColor, attrs: p.attrs }));
        }
        
        expect(newResult.length).toBe(oldResult.length);
    });

    it('STD color 04', async () => {
        expect(OldProtocol).not.toBeNull();
        const input = '\x1904\u2500\u2500\u2500';
        const newResult = rawText2Rich(input);
        const oldResult = OldProtocol!.rawText2Rich(input);
        
        console.log('=== NEW ===');
        for (const p of newResult) {
            console.log(JSON.stringify({ text: p.text, fgColor: p.fgColor, bgColor: p.bgColor, attrs: p.attrs }));
        }
        console.log('=== OLD ===');
        for (const p of oldResult) {
            console.log(JSON.stringify({ text: p.text, fgColor: p.fgColor, bgColor: p.bgColor, attrs: p.attrs }));
        }
        
        expect(true).toBe(true);
    });
});
