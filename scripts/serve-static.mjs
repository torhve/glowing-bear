#!/usr/bin/env node
/**
 * Minimal static file server for benchmarking production builds.
 *
 * Usage: node scripts/serve-static.mjs <rootDir> [port]
 * Serves SPA fallback to 404.html (adapter-static).
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? 'build');
const port = Number(process.argv[3] ?? 8001);

const types = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.mp3': 'audio/mpeg',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.json': 'application/json',
    '.webmanifest': 'application/manifest+json',
};

createServer(async (req, res) => {
    try {
        const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        let file = path.normalize(path.join(root, urlPath));
        if (!file.startsWith(root)) {
            res.writeHead(403);
            res.end();
            return;
        }
        try {
            const st = await stat(file);
            if (st.isDirectory()) file = path.join(file, 'index.html');
        } catch {
            file = path.join(root, '404.html');
        }
        const data = await readFile(file);
        res.writeHead(200, {
            'content-type': types[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
            'cache-control': 'no-store',
        });
        res.end(data);
    } catch (e) {
        res.writeHead(500);
        res.end(String(e));
    }
}).listen(port, () => {
    console.log(`[serve-static] ${root} on http://localhost:${port}`);
});
