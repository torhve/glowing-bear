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
})();

// Aliases managed via svelte.config.js kit.alias (propagated to Vite by SvelteKit)
// Explicit resolve aliases ensure Vite picks them up when configs are at repo root
export default defineConfig({
  define: {
    __GIT_COMMIT__: JSON.stringify(gitCommit),
  },
  resolve: {
    alias: {
      $lib: path.resolve(__dirname, 'src-svelte/src/lib'),
      $components: path.resolve(__dirname, 'src-svelte/src/components'),
    },
  },
  plugins: [
    sveltekit(),
    tailwindcss(),
    SvelteKitPWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Glowing Bear',
        short_name: 'Glowing Bear',
        lang: 'en-US',
        description: 'A weechat-websocket frontend',
        theme_color: '#0a0a0a',
        background_color: '#0a0a0a',
        display: 'standalone',
        orientation: 'portrait-primary',
        scope: '.',
        start_url: '.',
        icons: [
          { src: 'favicon.png', sizes: '32x32', type: 'image/png' },
          { src: 'apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
          { src: 'glowing_bear_60x60.png', sizes: '60x60', type: 'image/png' },
          { src: 'glowing_bear_90x90.png', sizes: '90x90', type: 'image/png' },
          { src: 'glowing_bear_128x128.png', sizes: '128x128', type: 'image/png' },
          { src: 'glowing_bear_192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'glowing_bear_512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'glowing_bear_1024x1024.png', sizes: '1024x1024', type: 'image/png' },
        ],
        prefer_related_applications: false,
        related_applications: [
          {
            platform: 'android',
            url: 'https://play.google.com/store/apps/details?id=com.glowing_bear',
          },
        ],
      },
      kit: {
        adapterFallback: '404.html',
        outDir: path.resolve(__dirname, 'src-svelte/.svelte-kit'),
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
