import { execSync } from 'node:child_process';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
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

// Aliases are managed in svelte.config.js kit.alias (propagated to Vite by SvelteKit).
export default defineConfig({
  define: {
    __GIT_COMMIT__: JSON.stringify(gitCommit),
  },
  plugins: [
    sveltekit(),
    tailwindcss(),
  ],
  optimizeDeps: {
    exclude: ['@lucide/svelte'],
  },
  ssr: {
    noExternal: ['@lucide/svelte'],
  },
  build: {
    target: 'es2022',
  },
  server: {
    port: 8001,
    forwardConsole: true,
    fs: {
      allow: ['src-svelte/src'],
    },
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
