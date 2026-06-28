import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter({
			pages: 'build',
			assets: 'build',
			fallback: '404.html',
			precompress: false,
			strict: false
		}),
		files: {
			routes: 'src-svelte/src/routes',
			lib: 'src-svelte/src/lib',
		},
		alias: {
			'$lib': 'src-svelte/src/lib',
			'$lib/*': 'src-svelte/src/lib/*',
			'$components': 'src-svelte/src/components',
			'$components/*': 'src-svelte/src/components/*',
		}
	}
};

export default config;
