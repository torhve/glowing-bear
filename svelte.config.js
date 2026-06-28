import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		paths: {
			base: process.env.BASE_PATH ?? '',
		},
		adapter: adapter({
			pages: 'build',
			assets: 'build',
			fallback: '404.html',
			precompress: false,
			strict: false
		}),
		outDir: 'src-svelte/.svelte-kit',
		files: {
			appTemplate: 'src-svelte/src/app.html',
			routes: 'src-svelte/src/routes',
			lib: 'src-svelte/src/lib',
			hooks: {
				server: 'src-svelte/src/hooks.server.ts',
			},
		},
		alias: {
			'$lib': 'src-svelte/src/lib',
			'$components': 'src-svelte/src/components',
		}
	}
};

export default config;
