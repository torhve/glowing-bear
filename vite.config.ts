import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { execSync } from 'node:child_process';
import { sveltekit } from '@sveltejs/kit/vite';

import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Capture the latest git commit hash at build time for display in settings.
// Priority: GIT_COMMIT env var (Docker build-arg) > git command > "unknown".
// An empty or whitespace-only GIT_COMMIT counts as unset: `??` alone would accept
// it and render "Glowing Bear version 0.23.1 ()" in Settings.
const gitCommit =
    process.env.GIT_COMMIT?.trim() ||
    (() => {
        try {
            return execSync('git rev-parse --short HEAD', { cwd: import.meta.dirname })
                .toString()
                .trim();
        } catch {
            return 'unknown';
        }
    })();

// $lib and $components are `#lib` / `#components` subpath imports declared in
// package.json "imports" — Kit 3 deprecated the `alias` option.
export default defineConfig({
    define: { __GIT_COMMIT__: JSON.stringify(gitCommit) },
    plugins: [
        sveltekit({
            preprocess: vitePreprocess(),
            paths: { base: process.env.BASE_PATH ?? '' },
            adapter: adapter({
                pages: 'build',
                assets: 'build',
                fallback: '404.html',
                precompress: false,
                strict: false
            }),
            outDir: 'src-svelte/.svelte-kit',
            files: {
                appTemplate: 'src-svelte/src/app.html',
                routes: 'src-svelte/src/routes',
                serviceWorker: 'src-svelte/src/service-worker/index.ts',
                hooks: { server: 'src-svelte/src/hooks.server.ts' }
            }
        }),
        tailwindcss({ optimize: false })
    ],
    optimizeDeps: { exclude: ['@lucide/svelte'] },
    ssr: { noExternal: ['@lucide/svelte'] },
    build: { target: 'es2022' },
    server: {
        port: 8001,
        forwardConsole: true,
        fs: {
            allow: ['src-svelte/src'],
        },
        watch: {
            ignored: [
                '**/node_modules/**',
                '**/.git/**',
                '**/build/**',
                '**/.svelte-kit/**',
                '**/src-tauri/**',
                '**/.opencode/**',
                '**/.playwright-mcp/**',
                '**/.pi/**',
                '**/.github/**',
                '**/.claude/**',
                '**/src-svelte/e2e/**',
                '**/src-svelte/test/**',
                '**/test/**',
                '**/test-results/**',
                '**/playwright-report/**',
                '**/doc/**',
                '**/plans/**',
                '**/specs/**',
                '**/library/**',
                '**/coverage/**',
                '**/src-angular/**',
                '*.tsbuildinfo',
            ],
        },
    },
});
