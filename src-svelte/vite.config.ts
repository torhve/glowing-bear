import { sveltekit } from '@sveltejs/kit/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import path from 'path';

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
  resolve: {
    alias: {
      $lib: path.resolve('./src/lib'),
      $components: path.resolve('./src/components'),
    },
  },
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
  },
});
