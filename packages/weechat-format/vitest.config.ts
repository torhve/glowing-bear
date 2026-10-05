import { defineConfig } from 'vitest/config';

// Isolated Node-environment configuration: the library has no Svelte, DOM or
// application dependencies, so it never reuses the app's jsdom setup.
export default defineConfig({
    // The differential and throughput suites import application sources from outside
    // this package. Pointing the transform at *this* package's tsconfig avoids the
    // app's unresolved `$app/tsconfig` chain; it does not modify the legacy parser
    // sources, and both are executed as shipped.
    oxc: { tsconfig: './tsconfig.json' },
    test: {
        environment: 'node',
        include: ['test/**/*.test.ts'],
    },
});
