import { test, expect } from '@playwright/test';

const RELAY_URL = 'ws://localhost:9001';
const PASSWORD = 'testpassword123';

test.describe.configure({ mode: 'serial' });

test.describe('WeeChat relay protocol (via browser WebSocket)', () => {

    test('handshake → init → version round-trip', async ({ page }) => {
        page.on('pageerror', (e) => {
            if (e.message?.includes('effect_orphan')) return;
        });

        await page.goto('http://localhost:8001/');
        // Wait for the connection form to be visible (app is stable)
        await page.waitForSelector('[data-testid="host-input"]', { timeout: 15000 });
        // Wait for Protocol to be exposed on window
        await page.waitForFunction(() => (window as any).__Protocol !== undefined, { timeout: 5000 });
        // Small delay to let the page stabilize
        await page.waitForTimeout(500);

        const result = await page.evaluate(async ({ RELAY_URL, PASSWORD }) => {
            const Protocol = (window as any).__Protocol;
            const protocol = new Protocol();
            const log: string[] = [];
            const step = (msg: string) => { log.push(msg); console.log(msg); };

            try {
                step('1. Creating WebSocket...');
                const ws = new WebSocket(RELAY_URL);
                ws.binaryType = 'arraybuffer';

                const connectPromise = new Promise<void>((resolve, reject) => {
                    ws.onopen = () => { step('2. WebSocket open'); resolve(); };
                    ws.onerror = () => reject(new Error('WebSocket error'));
                });
                await connectPromise;

                // Step 2: Send handshake
                const handshakeStr = Protocol.formatHandshake({
                    password_hash_algo: 'plain',
                    compression: 'zlib'
                });
                step('3. Sending handshake: ' + handshakeStr);
                ws.send(handshakeStr);

                const handshakeResponse = await new Promise<any>((resolve, reject) => {
                    const timeout = setTimeout(() => reject(new Error('Handshake timeout')), 10000);
                    ws.onmessage = (event) => {
                        clearTimeout(timeout);
                        try {
                            const parsed = protocol.parse(event.data as ArrayBuffer);
                            step('4. Handshake response parsed, objects: ' + parsed.objects.length);
                            resolve(parsed);
                        } catch (e: any) {
                            reject(new Error('Parse failed: ' + e.message));
                        }
                    };
                });

                // Verify handshake response has expected content
                const hsObj = handshakeResponse.objects[0];
                if (!hsObj || hsObj.type !== 'inf') {
                    throw new Error('Expected inf object, got ' + hsObj?.type);
                }
                const hsContent = hsObj.content as { key: string; value: string };
                if (hsContent.key !== 'password_hash_algo') {
                    throw new Error('Expected password_hash_algo, got ' + hsContent.key);
                }
                step('5. Auth method: ' + hsContent.value);

                // Step 3: Send init (fire-and-forget)
                const initStr = Protocol.formatInit('plain:' + PASSWORD, null);
                step('6. Sending init: ' + initStr);
                ws.send(initStr);

                // Small delay to let WeeChat process the init
                await new Promise(r => setTimeout(r, 50));

                // Step 4: Request version info with callback ID
                const versionStr = protocol.setId(1, Protocol.formatInfo({ name: 'version' }));
                step('7. Requesting version: ' + versionStr);
                ws.send(versionStr);

                const versionResponse = await new Promise<any>((resolve, reject) => {
                    const timeout = setTimeout(() => reject(new Error('Version timeout')), 10000);
                    ws.onmessage = (event) => {
                        clearTimeout(timeout);
                        try {
                            const parsed = protocol.parse(event.data as ArrayBuffer);
                            step('8. Version response parsed, objects: ' + parsed.objects.length);
                            resolve(parsed);
                        } catch (e: any) {
                            reject(new Error('Parse failed: ' + e.message));
                        }
                    };
                });

                // Verify version response
                if (versionResponse.id !== '(1)') {
                    throw new Error('Expected id "(1)", got "' + versionResponse.id + '"');
                }

                // Log object details
                for (const obj of versionResponse.objects) {
                    const c = obj.content;
                    if (obj.type === 'hda') {
                        const items = c as Record<string, unknown>[];
                        for (const item of items) {
                            step('  hda item keys: ' + Object.keys(item).join(', '));
                            if (item.value) step('  version value: ' + item.value);
                        }
                    } else {
                        step('  obj type=' + obj.type + ' content=' + JSON.stringify(c).slice(0, 100));
                    }
                    step('');
                }

                ws.close();

                return { success: true, log };
            } catch (e: any) {
                return { success: false, log, error: e.message };
            }
        }, { RELAY_URL, PASSWORD });

        // Print log regardless
        for (const line of result.log) {
            console.log(line);
        }

        expect(result.success).toBe(true);
        if (!result.success) {
            console.error('Test failed:', (result as any).error);
        }
    });
});
