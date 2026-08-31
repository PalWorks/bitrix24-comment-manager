import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';

const EXTENSION_ROOT = join(__dirname, '../../../extension');

/**
 * Recursively collects all files matching the given extensions
 * from the target directory.
 */
function collectFiles(dir: string, extensions: string[]): string[] {
    const results: string[] = [];

    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return results;
    }

    for (const entry of entries) {
        const fullPath = join(dir, entry);

        let stat;
        try {
            stat = statSync(fullPath);
        } catch {
            continue;
        }

        if (stat.isDirectory()) {
            if (entry === 'node_modules' || entry === 'dist' || entry === '.git') {
                continue;
            }
            results.push(...collectFiles(fullPath, extensions));
        } else if (extensions.includes(extname(entry))) {
            results.push(fullPath);
        }
    }

    return results;
}

/**
 * Patterns that indicate hardcoded secrets in source files.
 * Each pattern has a regex and a human readable label.
 */
const SECRET_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
    {
        pattern: /client_secret\s*[:=]\s*['"][A-Za-z0-9]{10,}['"]/gi,
        label: 'Hardcoded client_secret assignment',
    },
    {
        pattern: /api_key\s*[:=]\s*['"][A-Za-z0-9]{10,}['"]/gi,
        label: 'Hardcoded api_key assignment',
    },
    {
        pattern: /private_key\s*[:=]\s*['"][A-Za-z0-9/+=]{20,}['"]/gi,
        label: 'Hardcoded private_key assignment',
    },
    {
        pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/g,
        label: 'Embedded PEM private key',
    },
    {
        pattern: /BITRIX24_CLIENT_SECRET\s*=\s*['"]\S{10,}['"]/gi,
        label: 'Hardcoded BITRIX24_CLIENT_SECRET environment value',
    },
    {
        pattern: /JWT_SECRET\s*=\s*['"]\S{10,}['"]/gi,
        label: 'Hardcoded JWT_SECRET environment value',
    },
];

describe('Extension Security: Secrets Scan (T-6.2)', () => {
    const sourceFiles = collectFiles(EXTENSION_ROOT, ['.ts', '.js', '.json']);

    it('should find at least one source file to scan', () => {
        expect(sourceFiles.length).toBeGreaterThan(0);
    });

    it('should not contain hardcoded secrets in any source file', () => {
        const violations: Array<{ file: string; line: number; label: string }> = [];

        for (const filePath of sourceFiles) {
            const content = readFileSync(filePath, 'utf-8');
            const lines = content.split('\n');

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                for (const { pattern, label } of SECRET_PATTERNS) {
                    pattern.lastIndex = 0;
                    if (pattern.test(line)) {
                        violations.push({
                            file: filePath.replace(EXTENSION_ROOT, 'extension'),
                            line: i + 1,
                            label,
                        });
                    }
                }
            }
        }

        expect(violations).toEqual([]);
    });

    it('should not include .env files in extension source', () => {
        const envFiles = collectFiles(EXTENSION_ROOT, ['.env']);
        expect(envFiles).toEqual([]);
    });
});

describe('Extension Security: JWT Storage', () => {
    const tokenManagerPath = join(EXTENSION_ROOT, 'background', 'tokenManager.ts');

    /**
     * The JWT is held in chrome.storage.session, deliberately.
     *
     * Manifest V3 terminates an idle service worker, so a module scope variable
     * alone logs the agent out mid-session. chrome.storage.session is the right
     * home for it: memory backed rather than written to disk, cleared when the
     * browser closes, and not readable from content scripts. The two things
     * that must stay true are that it never reaches disk backed storage and
     * never reaches a context a web page can touch.
     */
    it('should keep the JWT in chrome.storage.session', () => {
        const content = readFileSync(tokenManagerPath, 'utf-8');
        expect(content).toContain('chrome.storage.session');
    });

    it('should not use chrome.storage.local for JWT storage', () => {
        const content = readFileSync(tokenManagerPath, 'utf-8');
        expect(content).not.toContain('chrome.storage.local');
    });

    it('should not use localStorage for JWT storage', () => {
        const content = readFileSync(tokenManagerPath, 'utf-8');
        expect(content).not.toContain('localStorage');
    });

    it('should not use sessionStorage for JWT storage', () => {
        const content = readFileSync(tokenManagerPath, 'utf-8');
        expect(content).not.toContain('sessionStorage');
    });

    it('should never write a token to chrome.storage.local anywhere in the extension', () => {
        const allFiles = collectFiles(EXTENSION_ROOT, ['.ts']);
        const violations: string[] = [];

        const storagePatterns = [
            /chrome\.storage\.local\.set\([^)]*jwt/gi,
            /chrome\.storage\.local\.set\([^)]*token/gi,
        ];

        for (const filePath of allFiles) {
            const content = readFileSync(filePath, 'utf-8');
            for (const pattern of storagePatterns) {
                pattern.lastIndex = 0;
                if (pattern.test(content)) {
                    violations.push(filePath.replace(EXTENSION_ROOT, 'extension'));
                }
            }
        }

        expect(violations).toEqual([]);
    });

    it('should not expose the token to content scripts', () => {
        const contentDir = join(EXTENSION_ROOT, 'content');
        const contentFiles = collectFiles(contentDir, ['.ts']);

        for (const filePath of contentFiles) {
            const content = readFileSync(filePath, 'utf-8');
            expect(content).not.toContain('tokenManager');
            expect(content).not.toContain('chrome.storage');
        }
    });
});

describe('Extension Security: CSP Verification (T-6.1)', () => {
    const manifestPath = join(EXTENSION_ROOT, 'manifest.json');

    it('should have a content_security_policy defined', () => {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        expect(manifest.content_security_policy).toBeDefined();
        expect(manifest.content_security_policy.extension_pages).toBeDefined();
    });

    it('should not include unsafe-inline in CSP', () => {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        const csp = manifest.content_security_policy.extension_pages;
        expect(csp).not.toContain('unsafe-inline');
    });

    it('should not include unsafe-eval in CSP', () => {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        const csp = manifest.content_security_policy.extension_pages;
        expect(csp).not.toContain('unsafe-eval');
    });

    it('should restrict script-src to self only', () => {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        const csp = manifest.content_security_policy.extension_pages;
        expect(csp).toContain("script-src 'self'");
    });

    /**
     * connect-src is deliberately absent.
     *
     * Each installation points at whichever backend its operator runs, and a
     * CSP is static in the manifest, so pinning connect-src would hard code one
     * deployment's hostname into the shipped build. Manifest V3's default
     * policy carries no connect-src, and outbound requests are governed by CORS
     * and host permissions instead. Adding one back would break every
     * self hosted installation.
     */
    it('should not pin connect-src to a single backend', () => {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        const csp = manifest.content_security_policy.extension_pages;
        expect(csp).not.toContain('connect-src');
    });

    it('should not hard code any backend hostname in the manifest', () => {
        const manifest = readFileSync(manifestPath, 'utf-8');
        expect(manifest).not.toMatch(/https:\/\/api\./);
        expect(manifest).not.toContain('oauth.bitrix.info');
    });

    it('should declare optional host permissions for user added portals', () => {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        expect(manifest.optional_host_permissions).toContain('https://*/*');
        expect(manifest.permissions).toContain('scripting');
    });

    it('should only request https origins', () => {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        const origins = [
            ...(manifest.host_permissions ?? []),
            ...(manifest.optional_host_permissions ?? []),
            ...(manifest.content_scripts ?? []).flatMap(
                (entry: { matches?: string[] }) => entry.matches ?? [],
            ),
        ];
        for (const origin of origins) {
            expect(origin.startsWith('https://')).toBe(true);
        }
    });
});
