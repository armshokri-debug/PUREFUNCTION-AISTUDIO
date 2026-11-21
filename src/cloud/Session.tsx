import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { isCloud, supabase, supabaseUrl } from './supabase';
import { clearPendingRecovery, hasPendingRecovery, markPendingRecovery } from './recoveryGate';
import { alternateGoogleMailDomain } from '../../supabase/functions/_shared/google-email-alias';

export interface Profile {
  id: string;
  role: 'coach' | 'client';
  displayName: string;
  clientId: string | null;
  email: string;
}

export type SessionStatus =
  | 'local' // no cloud configured: demo mode on this device
  | 'loading'
  | 'signed-out'
  | 'no-access' // signed in, but not the coach and not on a client list
  | 'reset' // opened a password-reset link: choose a new password
  | 'reset-complete' // updateUser succeeded; user must sign in again
  | 'ready';

interface SessionValue {
  status: SessionStatus;
  profile: Profile | null;
  email: string | null;
  signIn: (email: string, password: string, portal: Profile['role']) => Promise<string | null>;
  signUp: (email: string, password: string, name: string, portal: Profile['role']) => Promise<string | null>;
  signOut: () => Promise<void>;
  resendVerification: (email: string) => Promise<string | null>;
  /** One-time message for the sign-in screen (e.g. expired reset link). */
  notice: string | null;
  /** Emails a reset link. Returns an error message or null. */
  forgotPassword: (email: string) => Promise<string | null>;
  /** Saves a password only inside verified recovery; requires a fresh login afterwards. */
  setNewPassword: (password: string) => Promise<string | null>;
  /** Leaves the recovery success screen for a fresh password-based sign-in. */
  finishRecovery: () => void;
  /** Re-checks access, e.g. after the coach adds this email. */
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

function friendlyAuthError(message: string): string {
  if (/invalid login credentials/i.test(message)) return 'Email or password is not correct.';
  if (/email not confirmed/i.test(message)) return 'This account isn’t confirmed yet.';
  if (/network|fetch/i.test(message)) return 'No connection. Check your internet and try again.';
  return message;
}

export const SessionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [status, setStatus] = useState<SessionStatus>(isCloud ? 'loading' : 'local');
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const resetPending = React.useRef(hasPendingRecovery() || new URLSearchParams(window.location.search).has('reset'));
  const resetCompleted = React.useRef(false);

  const profileRequest = React.useRef(0);
  const loginPending = React.useRef(false);
  const loadProfile = useCallback(async (s: Session | null, portal?: Profile['role']): Promise<string | null> => {
    if (!supabase) return 'Cloud is not configured.';
    const request = ++profileRequest.current;
    // A recovery link creates a valid Supabase session BEFORE the password is changed.
    // Never show the workspace while recovery is pending, even after page refresh.
    if (resetPending.current) {
      setSession(s);
      setProfile(null);
      if (s) setStatus('reset');
      else {
        resetPending.current = false;
        clearPendingRecovery();
        setStatus('signed-out');
      }
      return null;
    }
    if (resetCompleted.current) return null;
    if (!s) {
      setProfile(null);
      setStatus('signed-out');
      return null;
    }
    const { data, error } = await supabase
      .from('profiles')
      .select('id, role, display_name, client_id')
      .eq('id', s.user.id)
      .maybeSingle();
    if (request !== profileRequest.current || resetPending.current || resetCompleted.current) return null;
    if (error || !data || !['coach', 'client'].includes(data.role)) {
      setProfile(null);
      setStatus('no-access');
      return null;
    }
    if (portal && data.role !== portal) {
      // Authenticate credentials first, then use the server-owned profile role.
      // Never mount a workspace for a mismatched portal, even briefly.
      ++profileRequest.current;
      setProfile(null); setSession(null); setStatus('signed-out');
      await supabase.auth.signOut({ scope: 'local' });
      return portal === 'coach'
        ? 'This is a client account. Choose “I’m a client” to sign in.'
        : 'This is a coach account. Choose “I’m the coach” to sign in.';
    }
    const next: Profile = {
      id: data.id,
      role: data.role,
      displayName: data.display_name,
      clientId: data.client_id,
      email: s.user.email ?? ''
    };
    // Supabase announces SIGNED_IN again every time the tab/app comes back into view. Keep the
    // same object when nothing changed, so the app does not reload all its data and reset the page.
    setProfile((prev) =>
      prev &&
      prev.id === next.id &&
      prev.role === next.role &&
      prev.displayName === next.displayName &&
      prev.clientId === next.clientId &&
      prev.email === next.email
        ? prev
        : next
    );
    setSession(s);
    setStatus('ready');
    return null;
  }, []);

  useEffect(() => {
    if (!supabase) return;
    let active = true;
    const params = new URLSearchParams(window.location.search);
    const resetToken = params.get('reset');
    const verifyToken = params.get('verify');
    const start = async () => {
      if (verifyToken) {
        const url = new URL(window.location.href);
        url.searchParams.delete('verify');
        url.searchParams.delete('verifyType');
        window.history.replaceState(null, '', url.toString());
        const { error } = await supabase!.auth.verifyOtp({
          type: params.get('verifyType') === 'magiclink' ? 'magiclink' : 'signup', token_hash: verifyToken
        });
        if (!active) return;
        if (error) setNotice('That verification link has expired or was already used. Request a new one.');
      }
      if (resetToken) {
        resetPending.current = true;
        markPendingRecovery();
        ++profileRequest.current;
        setProfile(null);
        setStatus('loading');
        const url = new URL(window.location.href);
        url.searchParams.delete('reset');
        window.history.replaceState(null, '', url.toString());
        const { data, error } = await supabase!.auth.verifyOtp({ type: 'recovery', token_hash: resetToken });
        if (!active) return;
        if (!error && data.session) {
          setSession(data.session);
          setStatus('reset');
          return;
        }
        resetPending.current = false;
        clearPendingRecovery();
        setNotice('That reset link has expired or was already used. Send a new one below.');
        // A failed recovery must not silently fall into a previously cached session.
        await supabase!.auth.signOut({ scope: 'local' });
      }
      const { data } = await supabase!.auth.getSession();
      if (!active) return;
      if (resetPending.current) {
        if (data.session) {
          setSession(data.session);
          setProfile(null);
          setStatus('reset');
        } else {
          resetPending.current = false;
          clearPendingRecovery();
          setNotice('Your recovery session expired. Please request a new link.');
          setStatus('signed-out');
        }
        return;
      }
      setSession(data.session);
      void loadProfile(data.session);
    };
    void start();
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (!active || (event === 'SIGNED_IN' && loginPending.current)) return;
      if (event === 'SIGNED_OUT') {
        ++profileRequest.current;
        setSession(null);
        setProfile(null);
        if (resetCompleted.current) {
          setStatus('reset-complete');
          return;
        }
        resetPending.current = false;
        clearPendingRecovery();
        setStatus('signed-out');
        return;
      }
      if (event === 'PASSWORD_RECOVERY') {
        resetPending.current = true;
        markPendingRecovery();
        ++profileRequest.current;
        setSession(s);
        setProfile(null);
        setStatus('reset');
        return;
      }
      if (resetCompleted.current) return;
      setSession(s);
      if (resetPending.current) {
        ++profileRequest.current;
        setProfile(null);
        if (s) setStatus('reset');
        return;
      }
      if (event === 'SIGNED_IN' || event === 'USER_UPDATED' || event === 'TOKEN_REFRESHED') {
        // Supabase warns against awaiting API calls inside this callback.
        window.setTimeout(() => {
          if (active && !loginPending.current && !resetPending.current && !resetCompleted.current) {
            void loadProfile(s);
          }
        }, 0);
      }
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [loadProfile]);

  const signIn = async (email: string, password: string, portal: Profile['role']) => {
    if (!supabase) return 'Cloud is not configured.';
    if (loginPending.current) return 'Sign-in is already in progress.';
    loginPending.current = true;
    ++profileRequest.current;
    try {
      const submittedEmail = email.trim();
      let { data, error } = await supabase.auth.signInWithPassword({ email: submittedEmail, password });
      // Only Google's documented domain aliases may fall back. Never rewrite other providers
      // or try another identity after a non-credentials failure (e.g. unconfirmed email).
      const alternate = alternateGoogleMailDomain(submittedEmail);
      if (error && alternate && /invalid login credentials/i.test(error.message)) {
        ({ data, error } = await supabase.auth.signInWithPassword({ email: alternate, password }));
      }
      if (error) return friendlyAuthError(error.message);
      resetPending.current = false;
      resetCompleted.current = false;
      clearPendingRecovery();
      setNotice(null);
      return await loadProfile(data.session, portal);
    } catch { return 'No connection. Check your internet and try again.'; }
    finally { loginPending.current = false; }
  };

  const signUp = async (email: string, password: string, name: string, portal: Profile['role']) => {
    if (!supabase) return 'Cloud is not configured.';
    const cleanEmail = email.trim();
    if (!cleanEmail) return 'Enter your email address.';
    if (password.length < 8) return 'Password must be at least 8 characters.';
    try {
      const res = await fetch(`${supabaseUrl}/functions/v1/sign-up`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: cleanEmail, password, name: name.trim() })
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        msg?: string;
        verificationRequired?: boolean;
      };
      if (!res.ok) return (body.error || body.message || body.msg || '').trim() || 'Could not create the account. Try again.';
      if (body.verificationRequired) return null;
    } catch {
      return 'No connection. Check your internet and try again.';
    }
    return signIn(cleanEmail, password, portal);
  };

  const resendVerification = async (email: string) => {
    if (!supabase) return 'Cloud is not configured.';
    const cleanEmail = email.trim();
    if (!cleanEmail) return 'Enter your email address.';
    try {
      const res = await fetch(`${supabaseUrl}/functions/v1/sign-up`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resend', email: cleanEmail })
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string; msg?: string };
      return res.ok ? null : (body.error || body.message || body.msg || '').trim() || 'Could not request verification. Try again.';
    } catch { return 'No connection. Check your internet and try again.'; }
  };

  const forgotPassword = async (email: string) => {
    if (!supabase) return 'Cloud is not configured.';
    const cleanEmail = email.trim();
    if (!cleanEmail) return 'Enter your email address.';
    try {
      const res = await fetch(`${supabaseUrl}/functions/v1/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: cleanEmail })
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string; msg?: string };
      return res.ok ? null : (body.error || body.message || body.msg || '').trim() || 'Could not send the email. Try again.';
    } catch {
      return 'No connection. Check your internet and try again.';
    }
  };

  const setNewPassword = async (password: string) => {
    if (!supabase) return 'Cloud is not configured.';
    if (!resetPending.current) return 'Open a fresh recovery link before changing your password.';
    if (password.length < 8 || password.length > 72) return 'Password must be 8 to 72 characters.';
    try {
      const { data, error } = await supabase.auth.updateUser({ password });
      if (error) return friendlyAuthError(error.message);
      if (!data.user) return 'Password change could not be confirmed. Please try again.';
      // Supabase confirmed the credential update. Do NOT treat the recovery session
      // as a normal login. Require entering the new password independently.
      resetCompleted.current = true;
      resetPending.current = false;
      clearPendingRecovery();
      ++profileRequest.current;
      setProfile(null);
      setSession(null);
      const { error: signOutError } = await supabase.auth.signOut({ scope: 'local' });
      setNotice(signOutError
        ? 'Password saved, but this device could not sign out. Close this tab before signing in again.'
        : null);
      setStatus('reset-complete');
      return null;
    } catch {
      return 'Could not save the password. Check your connection and try again.';
    }
  };

  const signOut = async () => {
    if (!supabase) return;
    resetPending.current = false;
    resetCompleted.current = false;
    clearPendingRecovery();
    ++profileRequest.current;
    setSession(null);
    setProfile(null);
    setStatus('signed-out');
    await supabase.auth.signOut();
  };

  return (
    <SessionContext.Provider
      value={{
        status,
        profile,
        email: session?.user.email ?? null,
        signIn,
        signUp,
        signOut,
        resendVerification,
        notice,
        forgotPassword,
        setNewPassword,
        finishRecovery: () => {
          resetCompleted.current = false;
          setNotice(null);
          setStatus('signed-out');
        },
        refresh: async () => { await loadProfile(session); }
      }}
    >
      {children}
    </SessionContext.Provider>
  );
};

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}
