import crypto from 'crypto';

/**
 * Authenticated encryption for credentials held at rest.
 *
 * AES-256-GCM with a random 96 bit IV per record. The stored format is
 *   v1.<iv-base64>.<authTag-base64>.<ciphertext-base64>
 * The version prefix leaves room to rotate the scheme later without having to
 * guess how an existing value was produced.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const VERSION = 'v1';

/**
 * Converts the configured 64 character hex key into a 32 byte buffer.
 * Throws when the key is missing or malformed, because silently falling back
 * to storing plaintext credentials would be worse than failing loudly.
 */
function toKey(hexKey: string): Buffer {
    if (!hexKey) {
        throw new Error('TOKEN_ENCRYPTION_KEY is not configured.');
    }
    if (!/^[0-9a-fA-F]{64}$/.test(hexKey)) {
        throw new Error('TOKEN_ENCRYPTION_KEY must be exactly 64 hexadecimal characters (32 bytes).');
    }
    return Buffer.from(hexKey, 'hex');
}

/**
 * Encrypts a UTF-8 string. Returns the versioned, self describing ciphertext.
 */
export function encryptSecret(plaintext: string, hexKey: string): string {
    const key = toKey(hexKey);
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    const ciphertext = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    return [
        VERSION,
        iv.toString('base64'),
        authTag.toString('base64'),
        ciphertext.toString('base64'),
    ].join('.');
}

/**
 * Decrypts a value produced by encryptSecret.
 * Throws when the payload is malformed or fails authentication, which is the
 * correct outcome: a tampered or wrongly keyed credential must not be used.
 */
export function decryptSecret(payload: string, hexKey: string): string {
    const key = toKey(hexKey);
    const parts = payload.split('.');

    if (parts.length !== 4 || parts[0] !== VERSION) {
        throw new Error('Encrypted value is malformed or uses an unsupported version.');
    }

    const [, ivB64, authTagB64, ciphertextB64] = parts;

    const decipher = crypto.createDecipheriv(
        ALGORITHM,
        key,
        Buffer.from(ivB64, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));

    return Buffer.concat([
        decipher.update(Buffer.from(ciphertextB64, 'base64')),
        decipher.final(),
    ]).toString('utf8');
}
