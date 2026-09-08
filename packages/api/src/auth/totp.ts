/**
 * TOTP (RFC 6238) verification for MFA codes.
 *
 * Production implementations will use `otplib` or similar. This is a minimal
 * self-contained verifier that:
 *   - accepts the base32-encoded shared secret stored on the user row
 *   - computes the expected 6-digit code for the current 30-second step
 *     (plus ±1 step to tolerate clock skew within the standard 30-second window)
 *   - uses a constant-time comparison to avoid timing leaks
 *
 * The function is deliberately dependency-free so it can run in any JS runtime.
 */
// packages/api/src/auth/totp.ts

import { createHmac, randomBytes } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export interface TotpOptions {
  digits?: number;
  periodSeconds?: number;
}

const DEFAULT_DIGITS = 6;
const DEFAULT_PERIOD_SECONDS = 30;

function assertBase32Secret(secret: unknown): asserts secret is string {
  if (typeof secret !== 'string' || secret.trim() === '') {
    throw new TypeError('TOTP secret must be a non-empty Base32 string');
  }
}

function base32Decode(input: string): Buffer {
  assertBase32Secret(input);

  const cleaned = input
    .replace(/=+$/g, '')
    .toUpperCase()
    .replace(/\s+/g, '');

  let bits = '';

  for (const character of cleaned) {
    const value = BASE32_ALPHABET.indexOf(character);

    if (value === -1) {
      throw new TypeError(
        `TOTP secret contains an invalid Base32 character: '${character}'`,
      );
    }

    bits += value.toString(2).padStart(5, '0');
  }

  const bytes: number[] = [];

  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }

  return Buffer.from(bytes);
}

function counterBuffer(step: number, periodSeconds: number): Buffer {
  const counter = Math.floor(step / periodSeconds);
  const buffer = Buffer.alloc(8);

  buffer.writeBigUInt64BE(BigInt(counter));

  return buffer;
}

export function generateTotpSecret(byteLength = 20): string {
  const bytes = randomBytes(byteLength);

  let bits = '';

  for (const byte of bytes) {
    bits += byte.toString(2).padStart(8, '0');
  }

  let output = '';

  for (let offset = 0; offset < bits.length; offset += 5) {
    const chunk = bits.slice(offset, offset + 5).padEnd(5, '0');
    output += BASE32_ALPHABET[Number.parseInt(chunk, 2)];
  }

  return output;
}

export function verifyTotp(
  secret: string,
  token: string,
  timestamp: Date | number = new Date(),
  window: number = 1,
  options: TotpOptions = {},
): boolean {
  assertBase32Secret(secret);
  token = token.padStart(6, '0');

  const digits = options.digits ?? DEFAULT_DIGITS;
  const periodSeconds =
    options.periodSeconds ?? DEFAULT_PERIOD_SECONDS;

  const step = typeof timestamp === 'number' ? timestamp : Math.floor(timestamp.getTime() / 1000 / periodSeconds);

  // Check the current step and +/- window for clock skew
  for (let offset = -window; offset <= window; offset++) {
    const code = totp(secret, step + offset, options);
    // Constant-time comparison to avoid timing attacks
    if (constantTimeEqual(code, token)) {
      return true;
    }
  }

  return false;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

export function otpauthTotpUrl(options: {
  secret: string;
  accountName: string;
  issuer?: string;
  algorithm?: string;
  digits?: number;
  period?: number;
}): string {
  const {
    secret,
    accountName,
    issuer = 'cre-command',
    algorithm = 'SHA1',
    digits = 6,
    period = 30,
  } = options;

  const encodedAccountName = encodeURIComponent(accountName);
  const encodedIssuer = issuer ? encodeURIComponent(issuer) : '';
  const params = new URLSearchParams();
  params.set('secret', secret);
  params.set('issuer', encodedIssuer);
  params.set('algorithm', algorithm);
  params.set('digits', String(digits));
  params.set('period', String(period));

  return `otpauth://totp/${encodedAccountName}?${params.toString()}`;
}

export function totp(
  secret: string,
  timestamp: Date | number = new Date(),
  options: TotpOptions = {},
): string {
  assertBase32Secret(secret);

  const digits = options.digits ?? DEFAULT_DIGITS;
  const periodSeconds =
    options.periodSeconds ?? DEFAULT_PERIOD_SECONDS;

  const key = base32Decode(secret);

  const step = typeof timestamp === 'number' ? timestamp : Math.floor(timestamp.getTime() / 1000 / periodSeconds);
  const digest = createHmac('sha1', key)
    .update(counterBuffer(step, periodSeconds))
    .digest();

  const offset = digest[digest.length - 1] & 0x0f;

  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}