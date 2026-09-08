/**
 * MFA secret encryption and recovery code management utilities.
 *
 * MFA secrets are stored encrypted at rest using AES-256-GCM. The encryption key
 * is provided via the MFA_ENCRYPTION_KEY environment variable (32 bytes, base64-encoded).
 *
 * Recovery codes are bcrypt-hashed and stored in the users table. Each code is
 * single-use; the array is replaced entirely when all codes are consumed.
 */
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';

import { compare, hash } from './passwords';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Resolves the at-rest encryption key on every call so configuration changes
 * are honored without a process restart and tests can scope the variable
 * per-suite. The value is a 32-byte base64-encoded key.
 */
function getEncryptionKey(): Buffer {
  const raw = process.env['MFA_ENCRYPTION_KEY']?.trim() || undefined;
  if (!raw) {
    throw new Error('MFA_ENCRYPTION_KEY environment variable is required for MFA functionality');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('MFA_ENCRYPTION_KEY must be 32 bytes (base64-encoded)');
  }
  return key;
}

export function encryptMfaSecret(plaintext: string): { encrypted: string; iv: string } {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  return {
    encrypted: encrypted + authTag.toString('hex'),
    iv: iv.toString('hex'),
  };
}

export function decryptMfaSecret(encrypted: string, ivHex: string): string {
  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(encrypted.slice(-AUTH_TAG_LENGTH * 2), 'hex');
  const encryptedContent = encrypted.slice(0, -AUTH_TAG_LENGTH * 2);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedContent, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

export const RECOVERY_CODE_COUNT = 10;
export const RECOVERY_CODE_LENGTH = 10;

export function generateRecoveryCodes(): string[] {
  // 32-symbol unambiguous alphabet (no I, O, 0, 1): matches ^[A-Z0-9]{10}$,
  // and 32 divides 256 evenly so byte → symbol mapping has no modulo bias.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const bytes = randomBytes(RECOVERY_CODE_LENGTH);
    let code = '';
    for (let j = 0; j < RECOVERY_CODE_LENGTH; j++) {
      code += alphabet[bytes[j] % alphabet.length];
    }
    codes.push(code);
  }
  return codes;
}

export async function hashRecoveryCodes(codes: string[]): Promise<string[]> {
  return Promise.all(codes.map((code) => hash(code)));
}

export async function verifyRecoveryCode(submitted: string, hashedCodes: string[]): Promise<{ valid: boolean; remainingCodes: string[] }> {
  for (let i = 0; i < hashedCodes.length; i++) {
    const isValid = await compare(submitted, hashedCodes[i]);
    if (isValid) {
      const remaining = [...hashedCodes];
      remaining.splice(i, 1);
      return { valid: true, remainingCodes: remaining };
    }
  }
  return { valid: false, remainingCodes: hashedCodes };
}
