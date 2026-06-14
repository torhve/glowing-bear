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
    {
      name: 'fflate-global',
      transform(code, id) {
        // Inject fflate global before any code that uses it
        if (id.includes('weechat.js')) {
          return {
            code: `
              import * as _fflate from 'fflate';
              globalThis.fflate = _fflate;
              ${code.replace(/const fflate = globalThis\.fflate/, 'const fflate = globalThis.fflate || _fflate')}
            `,
            map: null,
          };
        }
      },
    },
  ],
  resolve: {
    alias: {
      $lib: path.resolve('./src/lib'),
      $components: path.resolve('./src/components'),
    },
  },
  optimizeDeps: {
    include: ['fflate'],
    exclude: ['@lucide/svelte'],
  },
  ssr: {
    noExternal: ['@lucide/svelte'],
  },
  build: {
    target: 'es2022',
    commonjsOptions: {
      include: [/fflate/, /node_modules/],
    },
  },
  server: {
    port: 8001,
  },
});
