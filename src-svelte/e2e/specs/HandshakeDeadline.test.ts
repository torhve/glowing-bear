import { test, expect } from '@playwright/test';
import net from 'node:net';
import { setupEffectOrphanFilter } from '../helpers/pageerror';
import { waitForAppReady } from '../helpers/connection';

test.describe.configure({ mode: 'serial' });

/**
 * A relay that accepts the TCP connection and then never answers the WebSocket
 * upgrade.
 *
 * This is not a slow relay. It is the shape a plain TCP sink, a half-dead
 * reverse proxy, or a port belonging to something else makes: the browser
 * reports neither `open` nor `close` nor `error`, so the app has no event to
 * react to. Before the handshake deadline the consequence was not a cosmetic
 * stall — the status stayed `connecting`, `ConnectionForm` disables its own
 * Connect button on that status, and the user could not retry, cancel, or edit
 * the address. Only a page reload escaped.
 */
function startBlackhole(): Promise<{ port: number; close: () => Promise<void> }> {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        // Accepted, and then nothing at all.
    });

    // close() alone waits for every accepted socket to end, and a blackhole
    // keeps them by design — the test would hang in its own teardown.
    const close = () => new Promise<void>((done) => {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        server.close(() => done());
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (address === null || typeof address === 'string') throw new Error('sink did not bind');
            resolve({ port: address.port, close });
        });
    });
}

for (const protocol of ['legacy', 'api'] as const) {
    test(`a relay that never finishes the handshake does not hold the app hostage (${protocol})`, async ({ page }) => {
        setupEffectOrphanFilter(page);
        const sink = await startBlackhole();

        try {
            // Seeded before load rather than typed into the form: the form
            // populates its fields from the settings store once on mount, and the
            // address has to be the sink's before the first attempt starts.
            await page.addInitScript((init: Record<string, unknown>) => {
                localStorage.setItem('gb-settings', JSON.stringify(init));
            }, { protocol, autoconnect: false, hostField: '127.0.0.1', port: String(sink.port), tls: false });
            await page.goto('/');
            await waitForAppReady(page);

            await page.getByTestId('connect-button').click();

            // The attempt is genuinely hung, and the app says so.
            await expect(page.getByTestId('connect-button')).toBeDisabled();

            // ...and it stops on its own rather than staying hung for the life of
            // the page. The deadline is 10s; 25s is the margin, not the wait.
            await expect(page.getByTestId('connect-button'), 'the user must be able to try again').toBeEnabled({ timeout: 25_000 });

            // And told what happened, with the explanation that matches what the
            // app can actually know: a handshake that never completed is an
            // unreachable relay, not a password problem and not a generic fault.
            await expect(page.getByTestId('error-message')).toBeVisible();
            await expect(page.getByTestId('error-message')).toHaveAttribute('data-error-type', 'server-unreachable');

            // No retry loop was invented behind the user's back: autoconnect is
            // off, so this is one bounded attempt.
            await expect(page.getByTestId('connection-banner-countdown')).not.toBeVisible();
        } finally {
            await sink.close();
        }
    });
}
