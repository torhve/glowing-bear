// knip — "is anything exported or depended on that nothing reads?"
//
// The gate this repo uses: `npm run knip` must report nothing. What counts as a finding is
// stated here rather than left to the tool's defaults, because two of knip's default answers
// are wrong for this codebase.
const config = {
    ignoreDependencies: [
        // Used by the preserved AngularJS app (`src-angular/js/weechat.js`) and by the
        // old-protocol fixture `src-svelte/test/fixtures/weechat-old.js`. Both are outside
        // the Svelte app's analysis on purpose; the Svelte app decompresses with `fflate`.
        'zlibjs',
        // Declared but not imported in the Svelte app yet; wired up on the Rust side.
        '@tauri-apps/plugin-autostart',
        '@tauri-apps/plugin-window-state',
        // Pulled in by eslint-plugin-svelte, never imported from source.
        'svelte-eslint-parser',
        // Consumed by the Tailwind v4 Vite plugin and `app.css`, not by an import statement.
        'tailwindcss',
    ],
    // SvelteKit's own runtime modules are resolved by the bundler, not from disk.
    ignoreUnresolved: ['\\$app/.+'],
    // An export its own module reads is not dead surface. In this codebase the pattern is
    // deliberate: the legacy command builders in `weechat.ts` sit behind the `Protocol`
    // statics callers actually import, the event handlers in `handlers.ts` are registered in
    // that module's own dispatch table, and several exported types name a value inside an
    // exported signature (`BannerKind` inside what the banner reads, `ApiSessionDiagnostic`
    // inside the `onDiagnostic` callback). Only an export nothing at all reads is a finding.
    ignoreExportsUsedInFile: true,
    // System binaries a human or a fixture runs, not packages: the C compiler behind
    // `npm run oracle:weechat-format`, and the WeeChat relay the gbtest fixture shells out to
    // (`Dual-protocol.test.ts` reads its version).
    ignoreBinaries: ['cc', 'weechat-headless'],
    workspaces: {
        '.': {
            // Only the Svelte app's own files are analysed. `src-angular/` is preserved code,
            // the unit and E2E trees are consumers with their own contract, and `build/`,
            // `.svelte-kit/`, `static/` and `src-tauri/` are generated or non-TypeScript. The
            // test trees are not hidden — knip still notices what they shell out to, which is
            // why `weechat-headless` is named as a binary above instead of the specs being
            // excluded.
            project: [
                'src-svelte/src/**/*.ts',
                'src-svelte/src/**/*.svelte',
                '!src-svelte/src/**/*.d.ts',
            ],
        },
        'packages/weechat-format': {
            // `src/index.ts` is the only published entry. `list-divergences.mjs` is the one
            // tool with no npm script in front of it: a human runs it while re-pinning
            // `oracle/divergences.json`, which `AGENTS.md` calls the tracked record of
            // scanner-vs-renderer divergence. Everything else in the package is already
            // reachable from an npm script and knip says so itself.
            entry: ['src/index.ts', 'oracle/list-divergences.mjs'],
        },
    },
    // SvelteKit 3 has no svelte.config.js; the plugin needs the route-file spellings that
    // `vite.config.ts` gives Kit. Without these, `+layout.svelte`, `hooks.server.ts` and the
    // service worker look like files nothing imports.
    sveltekit: {
        config: ['vite.config.{js,mjs,ts,cjs,mts,cts}'],
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
