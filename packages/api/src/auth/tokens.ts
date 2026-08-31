import { createHash, randomBytes } from 'node:crypto';

/** Opaque bearer token plus its stored SHA-256 hash (the raw token is never persisted). */
export interface SessionToken {
  token: string;
  tokenHash: string;
}

export function newSessionToken(): SessionToken {
  const token = randomBytes(32).toString('hex');
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}