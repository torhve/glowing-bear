/// <reference no-default-lib="true" />
/// <reference lib="esnext" />
/// <reference lib="webworker" />
/// <reference types="@sveltejs/kit" />

import { version } from '$app/env';

const self = globalThis.self as unknown as ServiceWorkerGlobalScope;
const CACHE = `cache-${version}`;

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        for (const key of await caches.keys()) {
            if (key !== CACHE) await caches.delete(key);
        }
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    // Cross-origin requests must bypass the worker: re-issuing them inside a
    // service worker fails in Firefox (NS_ERROR_INTERCEPTION_FAILED) and
    // WebKit ("Load failed"). Without a respondWith() the browser performs
    // the fetch natively, which handles the CORS preflight correctly.
    if (event.request.mode === 'cors') return;
    event.respondWith(fetch(event.request));
});
