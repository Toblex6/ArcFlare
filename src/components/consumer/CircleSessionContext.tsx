// src/components/consumer/CircleSessionContext.tsx
//
// 'use client' — shared Circle user-controlled session for the consumer page.
//
// Problem it solves: UserControlledBridge (and CircleUserWallet onboarding)
// each held their Circle userToken/encryptionKey locally, so navigating
// between consumer views (Bridge → Swap → Save → Bridge) unmounted the
// holder and forced a fresh Google/email re-auth every time — even though
// the Circle session itself was still valid.
//
// This provider lifts the session to the consumer page level so every
// consumer feature reuses an already-valid session within the same visit:
//   - Bridge reads it before starting work and only shows the auth UI when
//     the token is actually missing or expired.
//   - Onboarding writes it through on login so a just-onboarded user can
//     bridge without a second Google/email ceremony.
//   - Future Swap/Save/etc. user-controlled flows consume the same hook.
//
// What is shared:
//   - credentials: { userToken, encryptionKey, circleUserId }
//   - sdkRef: the single Circle Web SDK instance, so challenge execution
//     (setAuthentication -> execute) keeps working after the owning view
//     unmounts/remounts. The per-transaction challenge flow itself is
//     unchanged — callers still setAuthentication per execute.
//
// Expiry: NO client-side timer. Circle's API is the authority on token
// lifetime (the Web SDK reports error code 155104 "userTokenExpired";
// the server-side listWallets 401 maps to CIRCLE_AUTH_EXPIRED). Callers
// call clearSession() when they receive any of those signals. Re-auth is
// NEVER triggered by view navigation alone or by an invented timer — only
// by the real expiry signal from Circle's infrastructure.
//
// Secrets discipline (mirrors UserControlledBridge / CircleUserWallet):
// credentials live in React state + an in-memory ref mirror only — never
// localStorage, never cookies, never logged. Cleared on provider unmount
// and on explicit clearSession (disconnect / wallet switch / expired-token
// responses). Only short-lived device-bound tokens touch sessionStorage
// (for the OAuth redirect bridge), never user credentials.

'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

export interface CircleSessionCreds {
  userToken: string;
  encryptionKey: string | null;
  circleUserId: string | null;
}

interface CircleSessionValue {
  /** Raw session or null when never-authed / cleared / API-expired. */
  creds: CircleSessionCreds | null;
  /** True when a userToken is held (not expired by the API). */
  hasValidSession: boolean;
  /** userToken, or null when re-auth is required. */
  getUserToken: () => string | null;
  /** encryptionKey (may itself be null), or null when re-auth is required. */
  getEncryptionKey: () => string | null;
  /** Store a fresh login result. */
  setSession: (creds: { userToken: string; encryptionKey: string | null; circleUserId: string | null }) => void;
  /**
   * Drop the session (disconnect, wallet switch, Circle API reports
   * userTokenExpired / 401 / CIRCLE_AUTH_EXPIRED).
   */
  clearSession: () => void;
  /**
   * Shared Circle Web SDK instance. Login flows assign it when they
   * construct the SDK; execution flows (setAuthentication -> execute) read
   * it so they survive view unmount/remount.
   */
  sdkRef: React.MutableRefObject<any>;
}

const CircleSessionContext = createContext<CircleSessionValue | null>(null);

export function CircleSessionProvider({ children }: { children: React.ReactNode }) {
  const [creds, setCreds] = useState<CircleSessionCreds | null>(null);
  // Synchronous mirror so executeChallenge-style callers read the latest
  // token without waiting a render.
  const credsRef = useRef<CircleSessionCreds | null>(null);
  const sdkRef = useRef<any>(null);

  const clearSession = useCallback(() => {
    credsRef.current = null;
    setCreds(null);
  }, []);

  // Token is valid as long as Circle's API hasn't rejected it. No
  // client-side timer — the real authority is the 155104 / 401 signal.
  const getUserToken = useCallback((): string | null => {
    return credsRef.current?.userToken ?? null;
  }, []);

  const getEncryptionKey = useCallback((): string | null => {
    return credsRef.current?.encryptionKey ?? null;
  }, []);

  const setSession = useCallback(
    (next: { userToken: string; encryptionKey: string | null; circleUserId: string | null }) => {
      const stored: CircleSessionCreds = {
        userToken: next.userToken,
        encryptionKey: next.encryptionKey,
        circleUserId: next.circleUserId,
      };
      credsRef.current = stored;
      setCreds(stored);
    },
    []
  );

  const hasValidSession = !!creds?.userToken;

  // Drop in-memory Circle credentials when the consumer visit ends.
  useEffect(() => {
    return () => {
      credsRef.current = null;
    };
  }, []);

  const value = useMemo<CircleSessionValue>(
    () => ({ creds, hasValidSession, getUserToken, getEncryptionKey, setSession, clearSession, sdkRef }),
    [creds, hasValidSession, getUserToken, getEncryptionKey, setSession, clearSession]
  );

  return <CircleSessionContext.Provider value={value}>{children}</CircleSessionContext.Provider>;
}

export function useCircleSession(): CircleSessionValue {
  const ctx = useContext(CircleSessionContext);
  if (!ctx) throw new Error('useCircleSession must be used inside <CircleSessionProvider>.');
  return ctx;
}

/** Null outside a provider — for flows (e.g. onboarding) that can seed the shared session when present. */
export function useOptionalCircleSession(): CircleSessionValue | null {
  return useContext(CircleSessionContext);
}
