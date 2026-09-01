import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TokenEncryption } from './crypto.js';

const KEY = randomBytes(32).toString('hex');

describe('TokenEncryption', () => {
  it('decrypts back to the original plaintext', () => {
    const enc = new TokenEncryption(KEY);
    const ciphertext = enc.encrypt('a-real-looking-access-token');
    expect(enc.decrypt(ciphertext)).toBe('a-real-looking-access-token');
  });

  it('produces different ciphertext for the same plaintext each call', () => {
    const enc = new TokenEncryption(KEY);
    const a = enc.encrypt('same-token');
    const b = enc.encrypt('same-token');
    // A fresh random IV per call is what makes this true; identical output
    // would mean the IV is not actually random, which defeats GCM's guarantees.
    expect(a).not.toBe(b);
    expect(enc.decrypt(a)).toBe('same-token');
    expect(enc.decrypt(b)).toBe('same-token');
  });

  it('fails to decrypt with the wrong key', () => {
    const enc = new TokenEncryption(KEY);
    const other = new TokenEncryption(randomBytes(32).toString('hex'));
    const ciphertext = enc.encrypt('secret');
    expect(() => other.decrypt(ciphertext)).toThrow();
  });

  it('rejects a key that is not 32 bytes of hex', () => {
    expect(() => new TokenEncryption('too-short')).toThrow(/ENCRYPTION_KEY must be/);
  });
});
