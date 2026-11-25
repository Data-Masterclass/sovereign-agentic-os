/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * FEATURE:    AuthGate — the client-side first-run gate after sign-in
 * USER STORY: As a new user I want to be sent to credential setup or shown a short onboarding
 *             the first time I sign in so that I start with a secure account and know where to begin.
 * ARCHITECTURE:
 *   - Mounted once in `app/layout.tsx`. Reads `/api/auth/me`; the Edge middleware cannot do this
 *     because it has no store access.
 *   - `mustChangeCredentials` redirects to `/onboarding/bootstrap`; otherwise, if not onboarded, it
 *     shows `OnboardingWizard` and POSTs `/api/auth/onboarded` when done.
 *   - Renders nothing on the public auth pages and never blocks the app shell.
 */
'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import type { Role } from '@core/kernel/session';
import OnboardingWizard from '@core/ui/OnboardingWizard';

type Me = {
  user: { id: string; name: string; role: Role; domains: string[] } | null;
  mustChangeCredentials?: boolean;
  onboarded?: boolean;
};

/**
 * Client-side first-run gate, mounted once in the root layout. It enforces two
 * post-login flows that the Edge middleware can't (it has no store access):
 *
 *  1. mustChangeCredentials → the signed-in bootstrap admin is redirected to the
 *     forced setup at /onboarding/bootstrap (real email + strong password).
 *  2. !onboarded → a one-time, role-aware onboarding wizard overlay.
 *
 * It renders nothing on public auth pages and never blocks the app shell.
 */
export default function AuthGate() {
  const pathname = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [wizardDone, setWizardDone] = useState(false);

  const isPublic =
    pathname.startsWith('/signin') ||
    pathname.startsWith('/recover') ||
    pathname.startsWith('/onboarding/bootstrap') ||
    // Setup step 2 (encryption keys): the page needs the admin session it already has; no overlay over it.
    pathname.startsWith('/onboarding/encryption');

  useEffect(() => {
    if (isPublic) return;
    let alive = true;
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((r) => r.json())
      .then((b: Me & { signedOut?: boolean }) => {
        if (!alive) return;
        // The server signed this browser out (deactivated or deleted user; the cookie is already
        // expired): go to sign-in now instead of leaving a half-working app on screen.
        if (b.signedOut) { window.location.assign('/signin'); return; }
        setMe(b);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [isPublic, pathname]);

  useEffect(() => {
    if (!me?.user) return;
    if (me.mustChangeCredentials && !pathname.startsWith('/onboarding/bootstrap')) {
      router.replace('/onboarding/bootstrap');
    }
  }, [me, pathname, router]);

  if (isPublic || !me?.user || me.mustChangeCredentials || me.onboarded || wizardDone) {
    return null;
  }

  return (
    <OnboardingWizard
      user={me.user}
      onDone={() => {
        setWizardDone(true);
        void fetch('/api/auth/onboarded', { method: 'POST' }).catch(() => {});
      }}
    />
  );
}
