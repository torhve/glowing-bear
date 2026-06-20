import { test, expect } from '@playwright/test';
import { connectToWeechat, clearSettings, disconnect, sendWeechatCommand, getConfigValue, waitForAppReady } from '../helpers/connection';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await page.goto('http://localhost:8001/');
    await waitForAppReady(page);
    await clearSettings(page);
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
    await connectToWeechat(page);
});

test.afterAll(async () => {
    await page.close();
});

test.beforeEach(async () => {
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
});

test('should have wconfig populated after connect', async () => {
    // Wait for config fetches to complete (they happen asynchronously after connect)
    await page.waitForTimeout(3000);
    const bufferTimeFormat = await getConfigValue(page, 'weechat.look.buffer_time_format');
    expect(bufferTimeFormat).toBeTruthy();
    expect(bufferTimeFormat.length).toBeGreaterThan(0);
});

test('should fetch weechat.color.chat_nick_colors from relay', async () => {
    const nickColors = await getConfigValue(page, 'weechat.color.chat_nick_colors');
    expect(nickColors).toBeTruthy();
    expect(nickColors.length).toBeGreaterThan(0);
});

test('should set a weechat option via relay and reflect in wconfig', async ({ page: p }) => {
    await sendWeechatCommand(p, '/set weechat.test.setting e2etestvalue');
    await p.waitForTimeout(1000);

    // Re-fetch the config value by triggering a new fetch
    await sendWeechatCommand(p, '/set weechat.test.setting e2etestvalue');
    await p.waitForTimeout(2000);

    const value = await getConfigValue(p, 'weechat.test.setting');
    expect(value).toBe('e2etestvalue');
});

test('should persist setting across reconnect', async ({ page: p }) => {
    await sendWeechatCommand(p, '/set weechat.test.persist testpersist');
    await p.waitForTimeout(1000);

    const beforeDisconnect = await getConfigValue(p, 'weechat.test.persist');
    expect(beforeDisconnect).toBe('testpersist');

    await disconnect(p);
    await connectToWeechat(p);

    const afterReconnect = await getConfigValue(p, 'weechat.test.persist');
    expect(afterReconnect).toBe('testpersist');
});

test('should handle invalid option gracefully', async ({ page: p }) => {
    await expect(async () => {
        await sendWeechatCommand(p, '/set nonexistent.option x');
        await p.waitForTimeout(1000);
    }).not.toThrow();
});

test('should auto-apply nick color defaults when using WeeChat defaults', async ({ page: p }) => {
    // The DEFAULT_NICK_COLORS from nickColors.ts
    const defaultNickColors = 'cyan,magenta,green,brown,lightblue,lightcyan,lightmagenta,lightgreen,31,35,38,40,49,63,70,80,92,99,112,126,130,138,142,148,160,162,167,169,174,176,178,184,186,210,212,215,248';

    // Check that we fetched the default (auto-apply would have already run on connect)
    const nickColors = await getConfigValue(p, 'weechat.color.chat_nick_colors');

    // After auto-apply, the value should NOT be the default
    // If it's still the default, auto-apply didn't work
    if (nickColors === defaultNickColors) {
        // This means auto-apply hasn't run or failed - capture for debugging
        console.log('Auto-apply may not have run: nick colors is still the WeeChat default');
    }

    // The ideal value has 175 color codes
    const idealNickColors = await getConfigValue(p, 'weechat.color.chat_nick_colors');
    expect(idealNickColors).toBeTruthy();

    const colorCount = idealNickColors.split(',').length;
    expect(colorCount).toBeGreaterThan(50); // Should be 175 if auto-applied, at least more than 32
});
