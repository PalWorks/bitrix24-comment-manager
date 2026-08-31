import { defineConfig } from 'vitest/config';
import { existsSync } from 'fs';

/**
 * Custom plugin to resolve .js imports to .ts source files.
 * Backend source files use Node ESM convention (import from './config.js'),
 * but Vitest resolves TypeScript source directly.
 */
function resolveJsToTs() {
    return {
        name: 'resolve-js-to-ts',
        enforce: 'pre' as const,
        resolveId(source: string, importer: string | undefined) {
            if (source.endsWith('.js') && importer) {
                const tsPath = source.replace(/\.js$/, '.ts');
                const resolved = new URL(tsPath, `file://${importer}`).pathname;
                if (existsSync(resolved)) {
                    return resolved;
                }
            }
            return null;
        },
    };
}

export default defineConfig({
    plugins: [resolveJsToTs()],
    resolve: {
        extensions: ['.ts', '.js', '.json'],
    },
    test: {
        globals: true,
        environment: 'node',
        include: ['tests/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html', 'lcov'],
            include: ['backend/src/**/*.ts', 'extension/**/*.ts'],
            exclude: ['**/*.test.ts', '**/*.d.ts', '**/node_modules/**'],
        },
    },
});
