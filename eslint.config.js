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
    ignores: ['build/', '.svelte-kit/', 'src-svelte/src/lib/weechat.js', 'src-svelte/src/routes/404.html', 'src-svelte/src/routes/index.html']
  }
);
