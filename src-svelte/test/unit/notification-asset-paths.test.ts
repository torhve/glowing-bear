import { describe, it, expect, afterEach, vi } from 'vitest';
import type { BufferData } from '#lib/types.ts';

/**
 * The two notification assets are addressed through `$app/paths`, so the app asks
 * for them the way it asks for every other file it ships.
 *
 * Both call sites used to hold hand-written root-absolute paths —
 * `'/glowing_bear_128x128.png'` and `'/assets/audio/sonar.mp3'` — which address
 * the origin root. On the Pages deployment (`BASE_PATH=/glowing-bear`, built by
 * `.github/workflows/deploy-pages.yml`) those paths name files that are not
 * there: the sound was silent and the notification icon missing, while the same
 * build served from the origin root worked, so a local check could not see it.
 *
 * The browser resolves both a `Notification` icon and an `Audio` src against the
 * document, and `$app/paths`' `asset()` emits a document-relative URL (`./...`,
 * measured in both builds — see the stub at `./mocks/app-paths.ts`). A test
 * cannot read the base off the returned string; it has to resolve that string
 * against the document the browser would have, which is what these tests do. The
 * `<base>` element stands for the deployment: the same code has to answer both.
 */

const BUFFER = { id: 7, shortName: '#chan', fullName: 'irc.libera.#chan' } as unknown as BufferData;

/** Point the document at another deployment for the duration of `body`. */
async function atDeployment(url: string, body: () => Promise<void>): Promise<void> {
    const baseEl = document.createElement('base');
    baseEl.href = url;
    document.head.appendChild(baseEl);
    try {
        await body();
    } finally {
        baseEl.remove();
    }
}

/** Resolve a URL the way the browser resolves it for the current document. */
function requested(value: string): string {
    return new URL(value, document.baseURI).pathname;
}

/** The src `playNotificationSound()` handed to `Audio`. */
async function soundSrc(): Promise<string> {
    const created: string[] = [];
    vi.stubGlobal('Audio', class {
        volume = 0;
        constructor(src: string) { created.push(src); }
        play = () => Promise.resolve();
    });
    const { updateSettings } = await import('#lib/stores/settings.ts');
    updateSettings({ soundnotification: true });

    const { playNotificationSound } = await import('#lib/notifications.ts');
    playNotificationSound();

    const [src] = created;
    if (typeof src !== 'string') throw new Error('playNotificationSound created no Audio');
    return src;
}

/** The icon `createHighlight()` handed to `Notification`. */
async function notificationIcon(): Promise<string> {
    const created: NotificationOptions[] = [];
    vi.stubGlobal('Notification', class {
        static permission = 'granted';
        static requestPermission = () => Promise.resolve('granted' as NotificationPermission);
        constructor(_title: string, options?: NotificationOptions) { created.push(options ?? {}); }
    });
    const { requestNotificationPermission } = await import('#lib/notifications.ts');
    // `createHighlight` reads the module's own permission, which only becomes
    // 'granted' through `requestNotificationPermission` — the path a visitor's
    // "Allow" click takes. The stub answers it with 'granted'.
    await expect(requestNotificationPermission()).resolves.toBe(true);

    const { createHighlight } = await import('#lib/notifications.ts');
    await createHighlight(BUFFER, 'a mention');

    const [options] = created;
    if (!options || typeof options.icon !== 'string') {
        throw new Error('createHighlight created no Notification carrying an icon');
    }
    return options.icon;
}

describe('notification assets follow the deployment', () => {
    afterEach(() => {
        vi.clearAllMocks();
        vi.unstubAllGlobals();
        vi.resetModules();
    });

    it('asks inside the deployment for the notification sound', async () => {
        await atDeployment('https://example.com/glowing-bear/', async () => {
            expect(requested(await soundSrc())).toBe('/glowing-bear/assets/audio/sonar.mp3');
        });
    });

    it('asks inside the deployment for the notification icon', async () => {
        await atDeployment('https://example.com/glowing-bear/', async () => {
            expect(requested(await notificationIcon())).toBe('/glowing-bear/glowing_bear_128x128.png');
        });
    });

    it('asks at the origin root when the deployment is the origin root', async () => {
        // The other address the one zip answers. A path that ignores the base
        // passes both deployments or neither, so this case is what separates
        // `asset()` from a hand-written root-absolute path.
        await atDeployment('https://example.com/', async () => {
            expect(requested(await soundSrc())).toBe('/assets/audio/sonar.mp3');
            expect(requested(await notificationIcon())).toBe('/glowing_bear_128x128.png');
        });
    });
});
