import js from '@eslint/js';
import ts from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';

export default ts.config(
  js.configs.recommended,
  ...ts.configs.recommended,
  ...svelte.configs['flat/recommended'],
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        // Vite build-time injected constant (see vite.config.ts)
        __GIT_COMMIT__: 'readonly'
      }
    }
  },
  {
    files: ['**/*.svelte'],
    languageOptions: {
      parser: svelte.parser,
      parserOptions: {
        parser: ts.parser
      }
    },
    rules: {
      'svelte/indent': ['error', { indent: 2 }],
      'svelte/no-trailing-spaces': 'error',
    }
  },
  {
    files: ['**/*.ts'],
    rules: {
      indent: ['error', 4],
      'no-tabs': 'error',
    }
  },
  {
    // Fixed sleeps are the main source of E2E flakiness: too short on a loaded machine,
    // still blind to the real condition on a fast one. Wait for the state the test
    // actually depends on.
    files: ['src-svelte/e2e/specs/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='waitForTimeout']",
          message:
            'No fixed sleeps in E2E specs. Wait for the real condition: e2e/helpers/waits.ts has waitForChatSettled, waitForRowCount, waitForUnreadAtLeast, waitForNoUnread, waitForSizeStable and waitForBotNickApplied; expect.poll covers anything else. A genuinely time-based wait (IRC pacing, a product timing window) needs an eslint-disable saying what it paces.',
        },
      ],
    },
  },
  {
    files: ['src-svelte/**/*.test.ts', 'src-svelte/e2e/**/*.ts', 'src-svelte/test/**/*'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-this-alias': 'off',
      'no-control-regex': 'off',
      'no-useless-escape': 'off',
      'no-empty': 'warn'
    }
  },
  {
    ignores: ['build/', '.svelte-kit/', 'src-svelte/src/lib/weechat.js']
  }
);
