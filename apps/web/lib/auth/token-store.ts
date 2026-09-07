/**
 * Minimal localStorage wrapper for the auth bearer token.
 *
 * The token is opaque (a random hex string from the API). We store it raw
 * and attach it as a `Bearer` header in `lib/api/client.ts`.
 *
 * SSR-safe: every function checks `typeof window` before touching localStorage.
 */

const TOKEN_KEY = 'cre_auth_token';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(TOKEN_KEY);
}
