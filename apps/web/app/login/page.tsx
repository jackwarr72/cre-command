'use client';

/**
 * Login page.
 *
 * Presents an email/password form. On success, the auth context stores the
 * bearer token and resolves the current user; we redirect to /dashboard.
 * If already authenticated, redirect immediately.
 *
 * When the server requires MFA, a second step is shown where the user
 * enters their TOTP code from their authenticator app.
 */
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

import { ApiError } from '@/lib/api';
import type { LoginRequest } from '@cre/shared';
import { useAuth } from '@/lib/auth/auth-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';

export default function LoginPage() {
  const router = useRouter();
  const { user, login, loading: authLoading, mfaChallenge, clearMfaChallenge } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!authLoading && user) {
      router.replace('/dashboard');
    }
  }, [authLoading, user, router]);

  if (authLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-noir-900">
        <Spinner className="size-6" />
      </div>
    );
  }

  const handlePasswordSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const credentials: LoginRequest = { email, password };
      const response = await login(credentials);
      if (response.mfaRequired) {
        setSubmitting(false);
        return;
      }
      router.replace('/dashboard');
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('An unexpected error occurred');
      }
      setSubmitting(false);
    }
  };

  const handleMfaSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!mfaChallenge) return;
    setSubmitting(true);
    setError(null);
    try {
      const credentials: LoginRequest = { email, password, mfaCode, mfaChallengeId: mfaChallenge?.challengeId };
      const response = await login(credentials);
      if (response.mfaRequired) {
        setError('Invalid MFA code. Please try again.');
        setMfaCode('');
        setSubmitting(false);
        return;
      }
      clearMfaChallenge();
      router.replace('/dashboard');
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('An unexpected error occurred');
      }
      setMfaCode('');
      setSubmitting(false);
    }
  };

  const handleBack = () => {
    clearMfaChallenge();
    setMfaCode('');
    setError(null);
  };

  return (
    <div className="flex h-screen items-center justify-center bg-noir-900">
      {!mfaChallenge ? (
        <form
          onSubmit={handlePasswordSubmit}
          className="w-full max-w-sm space-y-5 rounded-xl border border-noir-700 bg-noir-800 p-8"
        >
          <div className="text-center">
            <h1 className="text-2xl font-bold text-noir-50">cre-command</h1>
            <p className="text-sm text-noir-400">
              Commercial Real Estate Control Panel
            </p>
          </div>

          {error && (
            <div className="rounded-lg border border-accent-danger/30 bg-accent-danger/10 p-3 text-sm text-accent-danger">
              {error}
            </div>
          )}

          <Input
            label="Email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />

          <Input
            label="Password"
            type="password"
            autoComplete="current-password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />

          <Button type="submit" disabled={submitting} className="w-full" size="lg">
            {submitting ? 'Signing in...' : 'Sign In'}
          </Button>
        </form>
      ) : (
        <form
          onSubmit={handleMfaSubmit}
          className="w-full max-w-sm space-y-5 rounded-xl border border-noir-700 bg-noir-800 p-8"
        >
          <div className="text-center">
            <h1 className="text-2xl font-bold text-noir-50">Two-Factor Authentication</h1>
            <p className="text-sm text-noir-400">
              Enter the 6-digit code from your authenticator app
            </p>
          </div>

          {error && (
            <div className="rounded-lg border border-accent-danger/30 bg-accent-danger/10 p-3 text-sm text-accent-danger">
              {error}
            </div>
          )}

          <Input
            label="Verification Code"
            type="text"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            placeholder="000000"
            value={mfaCode}
            onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            autoFocus
            required
          />

          <div className="flex gap-3">
            <Button
              type="button"
              variant="ghost"
              onClick={handleBack}
              disabled={submitting}
              className="flex-1"
            >
              Back
            </Button>
            <Button type="submit" disabled={submitting || mfaCode.length !== 6} className="flex-1" size="lg">
              {submitting ? 'Verifying...' : 'Verify'}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
