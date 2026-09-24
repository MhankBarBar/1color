import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [svelte()],
	server: {
		// Bound to all interfaces so the dev server is reachable from outside the
		// container. HOST=localhost if you only want loopback.
		host: process.env.HOST || '0.0.0.0',
		port: Number(process.env.PORT) || 5173,
		strictPort: false
	},
	preview: {
		host: process.env.HOST || '0.0.0.0',
		port: Number(process.env.PORT) || 4173
	},
	build: {
		target: 'es2022'
	}
});
