import type { FullConfig } from '@playwright/test';

/* gbtest environment persists across test runs and does not need teardown.
   This hook exists so Playwright tracks lifecycle properly in reports. */
 
export default async function globalTeardown(_config: FullConfig) {
    console.log('[global-teardown] tests complete — gbtest environment kept running');
}
