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
import { createHmac, randomBytes } from 'node:crypto';

/** Encodes raw bytes as base32 (RFC 4648, uppercase, no padding). */
export function base32Encode(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5);
    out += alphabet[parseInt(chunk.padEnd(5, '0'), 2)];
  }
  return out;
}

/**
 * Generates a new random TOTP shared secret as an uppercase base32 string.
 * Defaults to 160 bits (20 bytes) — the RFC 6238 recommendation for SHA-1.
 */
export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

/**
 * Builds a standard `otpauth://` provisioning URI for authenticator apps.
 * `issuer` and `accountName` are percent-encoded; the secret is embedded as-is.
 */
export function otpauthTotpUrl(options: {
  secret: string;
  accountName: string;
  issuer: string;
}): string {
  // The label is `issuer:account`, URI-encoded as a single path segment per
  // the Google Authenticator Key URI format (the colon becomes %3A).
  const label = encodeURIComponent(`${options.issuer}:${options.accountName}`);
  const params = new URLSearchParams({
    secret: options.secret,
    issuer: options.issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Decodes a base32-encoded string into raw bytes. RFC 4648, no padding required. */
function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = input.replace(/=+$/g, '').toUpperCase().replace(/\s+/g, '');
  let bits = '';
  for (const ch of cleaned) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) throw new Error('invalid base32 character');
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  }
  return Buffer.from(bytes);
}

/** Constant-time string comparison. Returns false for unequal lengths. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Generates a 6-digit TOTP code for a given secret and time step. */
export function totp(secretBase32: string, step: number): string {
  const secret = base32Decode(secretBase32);
  const counter = Buffer.alloc(8);
  // step is seconds / 30, so up to ~10 bits for current era; high bytes are zero.
  // 8-byte big-endian per RFC 4226: high word at offset 0, low word at offset 4.
  counter.writeUInt32BE(Math.floor(step / 0x100000000), 0);
  counter.writeUInt32BE(step >>> 0, 4);
  const hmac = createHmac('sha1', secret).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

/**
 * Verifies a submitted 6-digit TOTP code against the shared secret.
 *
 * Accepts codes from the current 30-second step and the immediately adjacent
 * steps (±1) to tolerate clock skew between client and server.
 *
 * @returns `true` if the code matches any of the three valid steps.
 */
export function verifyTotp(secretBase32: string, submitted: string, now: Date = new Date()): boolean {
  if (!/^\d{6}$/.test(submitted)) return false;
  const step = Math.floor(now.getTime() / 30_000);
  // The submitted code is compared against current ± 1 step. The check is
  // constant-time across all three candidates so the server doesn't leak
  // which step matched.
  const candidates = [totp(secretBase32, step - 1), totp(secretBase32, step), totp(secretBase32, step + 1)];
  let match = false;
  for (const candidate of candidates) {
    if (timingSafeEqual(candidate, submitted)) match = true;
  }
  return match;
}
