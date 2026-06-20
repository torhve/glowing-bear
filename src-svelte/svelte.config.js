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
		alias: {
			'$lib': 'src/lib',
			'$lib/*': 'src/lib/*',
			'$components': 'src/components',
			'$components/*': 'src/components/*',
		}
	}
};

export default config;
