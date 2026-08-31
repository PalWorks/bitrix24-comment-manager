import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json';

export default defineConfig({
    plugins: [crx({ manifest })],
    envPrefix: 'VITE_',
    envDir: '..',
    build: {
        outDir: 'dist',
        emptyOutDir: true,
    },
});
