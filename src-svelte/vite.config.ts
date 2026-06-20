import { sveltekit } from '@sveltejs/kit/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Aliases managed via svelte.config.js kit.alias (propagated to Vite by SvelteKit)
export default defineConfig({
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
        globPatterns: ['client/**/*.{js,css,ico,png,svg,webp,webmanifest}'],
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
        '**/e2e/**',
        '**/test/**',
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
