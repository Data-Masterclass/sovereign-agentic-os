/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import type { Role } from '@/lib/core/session';
import OnboardingWizard from '@/components/OnboardingWizard';

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
    pathname.startsWith('/onboarding/bootstrap');

  useEffect(() => {
    if (isPublic) return;
    let alive = true;
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((r) => r.json())
      .then((b: Me) => {
        if (alive) setMe(b);
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
