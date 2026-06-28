import { execSync } from 'node:child_process';
import { sveltekit } from '@sveltejs/kit/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { defineConfig } from 'vite';

// Capture the latest git commit hash at build time for display in settings.
// Priority: GIT_COMMIT env var (Docker build-arg) > git command > "unknown"
const gitCommit = process.env.GIT_COMMIT ?? (() => {
    try {
        return execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim();
    } catch {
        return 'unknown';
    }
})()

    // Aliases managed via svelte.config.js kit.alias (propagated to Vite by SvelteKit)
    // Explicit resolve aliases ensure Vite picks them up when configs are at repo root
    export default defineConfig({
      define: {
        __GIT_COMMIT__: JSON.stringify(gitCommit),
      },
      resolve: {
        alias: {
          $lib: path.resolve(__dirname, 'src-svelte/src/lib'),
          '$lib/*': path.resolve(__dirname, 'src-svelte/src/lib/*'),
          $components: path.resolve(__dirname, 'src-svelte/src/components'),
          '$components/*': path.resolve(__dirname, 'src-svelte/src/components/*'),
        },
      },
      plugins: [
    sveltekit(),
    tailwindcss(),
        SvelteKitPWA({
          registerType: 'autoUpdate',
          manifest: false,
          kit: {
            adapterFallback: '404.html',
          },
          workbox: {
            // Static adapter outputs to build/ — scan there instead of client/
            globPatterns: ['**/*.{js,css,ico,png,svg,webp,webmanifest}'],
            navigateFallback: '404.html',
          },
        }),
  ],
  optimizeDeps: {
    exclude: ['@lucide/svelte'],
  },
  ssr: {
    noExternal: ['@lucide/svelte'],
  },
  build: {
    target: 'es2022',
    commonjsOptions: {
      include: [/node_modules/],
    },
  },
  server: {
    port: 8001,
    watch: {
      ignored: [
        '**/build/**',
        '**/.svelte-kit/**',
        '**/.opencode/**',
        '**/.playwright-mcp/**',
        '**/src-svelte/e2e/**',
        '**/src-svelte/test/**',
        '**/test-results/**',
        '**/playwright-report/**',
        '**/doc/**',
        '**/plans/**',
        '**/specs/**',
        '**/library/**',
        '**/coverage/**',
      ],
    },
  },
});
