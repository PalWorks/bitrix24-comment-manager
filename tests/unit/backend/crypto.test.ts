import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret } from '../../../backend/src/utils/crypto';

/**
 * Bitrix24 refresh tokens are long lived credentials, so they are encrypted
 * before they reach the database.
 */
describe('crypto', () => {
    const KEY = 'a'.repeat(64);
    const OTHER_KEY = 'b'.repeat(64);

    describe('round trip', () => {
        it('should decrypt back to the original plaintext', () => {
            const plaintext = 'bitrix-refresh-token-value';
            expect(decryptSecret(encryptSecret(plaintext, KEY), KEY)).toBe(plaintext);
        });

        it('should handle unicode and long values', () => {
            const plaintext = 'токен-üñíçøde-' + 'x'.repeat(4000);
            expect(decryptSecret(encryptSecret(plaintext, KEY), KEY)).toBe(plaintext);
        });

        it('should handle an empty string', () => {
            expect(decryptSecret(encryptSecret('', KEY), KEY)).toBe('');
        });
    });

    describe('ciphertext properties', () => {
        it('should produce a different ciphertext each time for the same input', () => {
            const a = encryptSecret('same-value', KEY);
            const b = encryptSecret('same-value', KEY);

            // A fresh random IV per record, so identical credentials do not
            // produce identical rows.
            expect(a).not.toBe(b);
            expect(decryptSecret(a, KEY)).toBe(decryptSecret(b, KEY));
        });

        it('should never contain the plaintext', () => {
            expect(encryptSecret('super-secret-token', KEY)).not.toContain('super-secret-token');
        });

        it('should carry a version prefix', () => {
            expect(encryptSecret('value', KEY).startsWith('v1.')).toBe(true);
        });
    });

    describe('failure modes', () => {
        it('should refuse a missing key rather than storing plaintext', () => {
            expect(() => encryptSecret('value', '')).toThrow(/not configured/);
        });

        it('should refuse a malformed key', () => {
            expect(() => encryptSecret('value', 'too-short')).toThrow(/64 hexadecimal/);
            expect(() => encryptSecret('value', 'z'.repeat(64))).toThrow(/64 hexadecimal/);
        });

        it('should refuse to decrypt with the wrong key', () => {
            expect(() => decryptSecret(encryptSecret('value', KEY), OTHER_KEY)).toThrow();
        });

        it('should refuse a tampered ciphertext', () => {
            const encrypted = encryptSecret('value', KEY);
            const parts = encrypted.split('.');
            const tampered = [
                parts[0],
                parts[1],
                parts[2],
                Buffer.from('different-content').toString('base64'),
            ].join('.');

            expect(() => decryptSecret(tampered, KEY)).toThrow();
        });

        it('should refuse a malformed payload', () => {
            expect(() => decryptSecret('not-encrypted', KEY)).toThrow(/malformed/);
            expect(() => decryptSecret('v9.a.b.c', KEY)).toThrow(/malformed/);
        });
    });
});
