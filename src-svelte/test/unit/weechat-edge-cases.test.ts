import { describe, it, expect } from 'vitest';
import { Protocol } from '$lib/weechat';
import { buildMessage } from './buildMessage';

describe('Protocol array parsing', () => {
    it('parses array of strings (tags)', async () => {
        const binary = buildMessage('cbid8', [
            { type: 'arr', content: ['hilight', 'time', 'message'] }
        ]);
        const protocol = new Protocol();
        const result = await protocol.parse(binary);
        expect(result.objects[0]!.type).toBe('arr');
    });

    it('parses array of integers', async () => {
        const binary = buildMessage('cbid9', [
            { type: 'arr', content: [1, 2, 3, 4] }
        ]);
        const protocol = new Protocol();
        const result = await protocol.parse(binary);
        expect(result.objects[0]!.type).toBe('arr');
    });
});

describe('Protocol edge cases', () => {
    it('handles callback ID with hyphens', async () => {
        const binary = buildMessage('cbid-99', [{ type: 'str', content: 'test' }]);
        const protocol = new Protocol();
        const result = await protocol.parse(binary);
        expect(result.id).toBe('cbid-99');
    });

    it('handles large callback IDs', async () => {
        const binary = buildMessage('cbid999999', [{ type: 'str', content: 'data' }]);
        const protocol = new Protocol();
        const result = await protocol.parse(binary);
        expect(result.id).toBe('cbid999999');
    });

    it('handles single-byte char values', async () => {
        const binary = buildMessage('cbid10', [{ type: 'chr', content: 65 }]);
        const protocol = new Protocol();
        const result = await protocol.parse(binary);
        expect(result.objects[0]!.type).toBe('chr');
        expect(result.objects[0]!.content).toBe(65);
    });

    it('handles buffer pointer strings with full IRC path', async () => {
        const binary = buildMessage('cbid11', [{ type: 'buf', content: 'irc.libera.chat+#general' }]);
        const protocol = new Protocol();
        const result = await protocol.parse(binary);
        expect(result.objects[0]!.type).toBe('buf');
        expect(result.objects[0]!.content).toBe('irc.libera.chat+#general');
    });

    it('handles negative integer values', async () => {
        const binary = buildMessage('cbid12', [{ type: 'int', content: -1 }]);
        const protocol = new Protocol();
        const result = await protocol.parse(binary);
        expect((result.objects[0]!.content as number)).toBe(-1);
    });

    it('handles zero integer value', async () => {
        const binary = buildMessage('cbid13', [{ type: 'int', content: 0 }]);
        const protocol = new Protocol();
        const result = await protocol.parse(binary);
        expect((result.objects[0]!.content as number)).toBe(0);
    });
});
