import * as crypto from 'node:crypto';

/**
 * AES-256-GCM for access tokens at rest.
 *
 * Wire format is `iv | authTag | ciphertext`, hex, with fixed-width prefixes so
 * decrypt can slice without a delimiter.
 */
const IV_BYTES = 12; // 96-bit nonce: the size GCM is specified for.
const TAG_BYTES = 16;
const IV_HEX = IV_BYTES * 2;
const TAG_HEX = TAG_BYTES * 2;
const KEY_HEX = 64; // 32 bytes.

export class TokenEncryption {
  private readonly key: Buffer;

  constructor(keyHex: string) {
    if (keyHex.length !== KEY_HEX || !/^[0-9a-fA-F]+$/.test(keyHex)) {
      throw new Error(
        `ENCRYPTION_KEY must be ${KEY_HEX} hex characters (32 bytes). ` +
          'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
      );
    }
    this.key = Buffer.from(keyHex, 'hex');
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return iv.toString('hex') + cipher.getAuthTag().toString('hex') + encrypted.toString('hex');
  }

  decrypt(ciphertext: string): string {
    if (ciphertext.length <= IV_HEX + TAG_HEX) {
      throw new Error('Ciphertext is too short to contain an IV and auth tag.');
    }

    const iv = Buffer.from(ciphertext.slice(0, IV_HEX), 'hex');
    const authTag = Buffer.from(ciphertext.slice(IV_HEX, IV_HEX + TAG_HEX), 'hex');
    const encrypted = Buffer.from(ciphertext.slice(IV_HEX + TAG_HEX), 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(authTag);
    // Both halves decoded as utf8 explicitly. Concatenating a raw Buffer with a
    // string relies on Buffer.toString()'s default and splits any multi-byte
    // character that straddles the update/final boundary.
    return decipher.update(encrypted, undefined, 'utf8') + decipher.final('utf8');
  }
}
