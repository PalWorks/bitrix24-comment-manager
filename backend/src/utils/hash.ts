import crypto from 'crypto';

/**
 * Computes a SHA-256 hex digest of the given input string.
 * Used for duplicate comment detection by hashing comment bodies.
 */
export function sha256(input: string): string {
    return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}
