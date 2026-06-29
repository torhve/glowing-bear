const config = {
    // Files to analyze
    project: [
        'src-svelte/src/**/*.ts',
        'src-svelte/src/**/*.svelte',
        '!src-svelte/src/**/*.d.ts',
    ],
    // Files outside project scope to exclude from analysis
    ignore: [
        // Legacy AngularJS code — preserved but not part of active build
        'src-angular/**',
        // Test infrastructure excluded from analysis
        'src-svelte/test/**',
        'src-svelte/e2e/**',
        // Generated output directories
        'build/**',
        '.svelte-kit/**',
        // Static assets
        'static/**',
        // Tauri backend config
        'src-tauri/**',
        // Documentation and planning docs
        'doc/**',
        'plans/**',
        'specs/**',
        'library/**',
    ],
    // Import alias resolution ($lib handled by SvelteKit plugin)
    paths: {
        '$components': ['./src-svelte/src/components'],
        '$components/*': ['./src-svelte/src/components/*'],
    },
    // Dependencies to skip (not statically imported in source)
    ignoreDependencies: [
        // Dynamic import at runtime only
        'zlibjs',
        // Tauri CLI — dev-only, used via npm scripts
        '@tauri-apps/cli',
        // Tauri plugins — not imported in source yet
        '@tauri-apps/plugin-autostart',
        '@tauri-apps/plugin-window-state',
        // Peer deps of other packages (knip doesn't trace meta-package re-exports)
        '@typescript-eslint/eslint-plugin',
        '@typescript-eslint/parser',
        'svelte-eslint-parser',
        'tailwindcss',
    ],
    // Unresolvable import specifiers
    ignoreUnresolved: [
        'virtual:pwa-register',   // Vite PWA plugin virtual module
        '\\$app/.+',              // SvelteKit runtime modules
    ],
    // Plugin configuration — override default src/ paths for our src-svelte/ layout
    sveltekit: {
        config: ['svelte.config.js', 'vite.config.{js,mjs,ts,cjs,mts,cts}'],
        entry: [
            'src-svelte/src/routes/**/+{page,server,page.server,error,layout,layout.server}{,@*}.{js,ts,svelte}',
            'src-svelte/src/hooks.{server,client}.{js,ts}',
            'src-svelte/src/params/*.{js,ts}',
            'src-svelte/src/service-worker.{js,ts}',
            'src-svelte/src/service-worker/index.{js,ts}',
            'src-svelte/src/instrumentation.server.{js,ts}',
        ],
    },
};

export default config;
