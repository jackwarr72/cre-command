'use client';

/**
 * Auth context for the control panel.
 *
 * Manages:
 *   - token persistence in localStorage (read once on mount, written on login/logout)
 *   - current-user resolution via SWR + GET /api/auth/me
 *   - login/logout mutations with token lifecycle
 *   - MFA challenge state for two-step login flow
 *
 * The provider is mounted at the root layout; the `(app)` group layout
 * consumes `useAuth()` to gate access and redirect unauthenticated users.
 */
import { useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import useSWR, { useSWRConfig } from 'swr';

import { authApi } from '@/lib/api';
import { clearToken, getToken, setToken } from '@/lib/auth/token-store';
import type { LoginRequest, LoginResponse, User } from '@cre/shared';

export interface MfaChallenge {
  challengeId: string;
  ttlSeconds: number;
}

interface AuthContextValue {
  /** The current user, or null if not authenticated. */
  user: User | null;
  /** True while the initial session check (or a login/logout flow) is in progress. */
  loading: boolean;
  /** Active MFA challenge when the server requires a second factor. */
  mfaChallenge: MfaChallenge | null;
  /** Clears the MFA challenge state. */
  clearMfaChallenge: () => void;
  /** Persists the session token and triggers a user re-fetch. */
  login: (credentials: LoginRequest) => Promise<LoginResponse>;
  /** Clears the session token and resets state. */
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/** Must be called within an `AuthProvider`. */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { mutate } = useSWRConfig();
  const [token, setTokenState] = useState<string | null>(getToken);
  const [mfaChallenge, setMfaChallenge] = useState<MfaChallenge | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const {
    data: user,
    isValidating,
    error,
  } = useSWR<User>(
    token ? ['/api/auth/me'] : null,
    () => authApi.getCurrentUser(),
    {
      revalidateOnFocus: true,
      dedupingInterval: 60_000,
    },
  );

  useEffect(() => {
    if (token && error) {
      clearToken();
      setTokenState(null);
    }
  }, [token, error]);

  const isLoading = !mounted || (token !== null && isValidating && user === undefined);

  const clearMfaChallenge = () => setMfaChallenge(null);

  const login = async (credentials: LoginRequest): Promise<LoginResponse> => {
    const response: LoginResponse = await authApi.login(credentials);
    if (response.mfaRequired && response.mfaChallengeId && response.mfaChallengeTtlSeconds) {
      setMfaChallenge({
        challengeId: response.mfaChallengeId,
        ttlSeconds: response.mfaChallengeTtlSeconds,
      });
      return response;
    }
    setToken(response.token);
    setTokenState(response.token);
    setMfaChallenge(null);
    await mutate(['/api/auth/me']);
    return response;
  };

  const logout = async (): Promise<void> => {
    await authApi.logout();
    clearToken();
    setTokenState(null);
    setMfaChallenge(null);
    mutate(['/api/auth/me'], null, { populateCache: false });
  };

  return (
    <AuthContext.Provider
      value={{
        user: user ?? null,
        loading: isLoading,
        mfaChallenge,
        clearMfaChallenge,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
