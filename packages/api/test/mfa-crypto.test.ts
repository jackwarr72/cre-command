import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';

import { decryptMfaSecret, encryptMfaSecret } from '../src/auth/mfa-crypto';

const ENV_KEY = 'MFA_ENCRYPTION_KEY';
const ORIGINAL_ENCRYPTION_KEY = process.env[ENV_KEY];

const VALID_KEY = Buffer.alloc(32, 1).toString('base64');
const DIFFERENT_VALID_KEY = Buffer.alloc(32, 2).toString('base64');

const SECRET = 'JBSWY3DPEHPK3PXP';

function setEncryptionKey(value: string | undefined): void {
  if (value === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = value;
  }
}

function mutateBase64(value: string): string {
  const last = value[value.length - 1];
  const replacement = last === 'A' ? 'B' : 'A';
  return `${value.slice(0, -1)}${replacement}`;
}

afterEach(() => {
  setEncryptionKey(ORIGINAL_ENCRYPTION_KEY);
});

describe('mfa-crypto', () => {
  describe('encryptMfaSecret', () => {
    it('encrypts and decrypts a secret with a valid 32-byte base64 key', () => {
      setEncryptionKey(VALID_KEY);

      const encrypted = encryptMfaSecret(SECRET);
      expect(encrypted).toHaveProperty('encrypted');
      expect(encrypted).toHaveProperty('iv');
      expect(typeof encrypted.encrypted).toBe('string');
      expect(typeof encrypted.iv).toBe('string');
      expect(encrypted.encrypted).not.toBe(SECRET);
      expect(encrypted.encrypted.length).toBeGreaterThan(0);
      expect(encrypted.iv.length).toBeGreaterThan(0);

      const decrypted = decryptMfaSecret(encrypted.encrypted, encrypted.iv);
      expect(decrypted).toBe(SECRET);
    });

    it('produces different ciphertext and IV for the same secret', () => {
      setEncryptionKey(VALID_KEY);

      const first = encryptMfaSecret(SECRET);
      const second = encryptMfaSecret(SECRET);

      expect(first.encrypted).not.toBe(second.encrypted);
      expect(first.iv).not.toBe(second.iv);
    });

    it('throws when MFA_ENCRYPTION_KEY is missing', () => {
      setEncryptionKey(undefined);

      expect(() => encryptMfaSecret(SECRET)).toThrow(
        /MFA_ENCRYPTION_KEY.*required/i,
      );
    });

    it('throws when MFA_ENCRYPTION_KEY does not decode to exactly 32 bytes', () => {
      const wrongLengthKey = Buffer.alloc(16, 1).toString('base64');

      setEncryptionKey(wrongLengthKey);

      expect(() => encryptMfaSecret(SECRET)).toThrow(
        /MFA_ENCRYPTION_KEY.*32 bytes/i,
      );
    });

    it('reads MFA_ENCRYPTION_KEY when encryption is called (dynamic key)', () => {
      setEncryptionKey(VALID_KEY);

      const first = encryptMfaSecret(SECRET);

      setEncryptionKey(DIFFERENT_VALID_KEY);

      const second = encryptMfaSecret(SECRET);

      expect(first.encrypted).not.toBe(second.encrypted);
      expect(first.iv).not.toBe(second.iv);
    });

    it('rejects a base64 key that decodes to more than 32 bytes', () => {
      const wrongLengthKey = Buffer.alloc(33, 1).toString('base64');

      setEncryptionKey(wrongLengthKey);

      expect(() => encryptMfaSecret(SECRET)).toThrow(
        /MFA_ENCRYPTION_KEY.*32 bytes/i,
      );
    });
  });

  describe('decryptMfaSecret', () => {
    it('decrypts ciphertext back to the original secret', () => {
      setEncryptionKey(VALID_KEY);

      const encrypted = encryptMfaSecret(SECRET);

      expect(
        decryptMfaSecret(encrypted.encrypted, encrypted.iv),
      ).toBe(SECRET);
    });

    it('rejects tampered ciphertext', () => {
      setEncryptionKey(VALID_KEY);

      const encrypted = encryptMfaSecret(SECRET);
      const tamperedCiphertext = mutateBase64(encrypted.encrypted);

      expect(() =>
        decryptMfaSecret(tamperedCiphertext, encrypted.iv),
      ).toThrow();
    });

    it('rejects ciphertext encrypted with a different key', () => {
      setEncryptionKey(VALID_KEY);

      const encrypted = encryptMfaSecret(SECRET);

      setEncryptionKey(DIFFERENT_VALID_KEY);

      expect(() =>
        decryptMfaSecret(encrypted.encrypted, encrypted.iv),
      ).toThrow();
    });

    it.each([
      ['an empty ciphertext', '', ''],
      ['a non-base64 ciphertext', 'not-valid-base64-@@@', ''],
      ['a truncated ciphertext', 'AQ', ''],
    ])('rejects %s', (_description: string, ciphertext: string, iv: string) => {
      setEncryptionKey(VALID_KEY);

      expect(() =>
        decryptMfaSecret(ciphertext, iv),
      ).toThrow();
    });

    it('rejects an empty IV', () => {
      setEncryptionKey(VALID_KEY);

      const encrypted = encryptMfaSecret(SECRET);

      expect(() =>
        decryptMfaSecret(encrypted.encrypted, ''),
      ).toThrow();
    });

    it('rejects a malformed IV', () => {
      setEncryptionKey(VALID_KEY);

      const encrypted = encryptMfaSecret(SECRET);

      expect(() =>
        decryptMfaSecret(encrypted.encrypted, 'not-valid-base64-@@@'),
      ).toThrow();
    });

    it('rejects a tampered IV', () => {
      setEncryptionKey(VALID_KEY);

      const encrypted = encryptMfaSecret(SECRET);
      const tamperedIv = mutateBase64(encrypted.iv);

      expect(() =>
        decryptMfaSecret(encrypted.encrypted, tamperedIv),
      ).toThrow();
    });

    it('does not return plaintext for malformed encrypted payloads', () => {
      setEncryptionKey(VALID_KEY);

      const malformedPayloads = [
        { encrypted: '', iv: '' },
        { encrypted: 'AAAA', iv: 'AAAA' },
        { encrypted: '!!!!', iv: '!!!!' },
        { encrypted: 'AAECAwQ=', iv: 'AAECAwQ=' },
      ];

      for (const payload of malformedPayloads) {
        expect(() =>
          decryptMfaSecret(payload.encrypted, payload.iv),
        ).toThrow();
      }
    });

    it('reads MFA_ENCRYPTION_KEY when decryption is called (dynamic key)', () => {
      setEncryptionKey(VALID_KEY);

      const encrypted = encryptMfaSecret(SECRET);

      setEncryptionKey(DIFFERENT_VALID_KEY);

      expect(() =>
        decryptMfaSecret(encrypted.encrypted, encrypted.iv),
      ).toThrow();

      setEncryptionKey(VALID_KEY);

      expect(
        decryptMfaSecret(encrypted.encrypted, encrypted.iv),
      ).toBe(SECRET);
    });
  });
});