/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
// The vendored @sovereign-os/ui theme — the SAME stylesheet each app repo carries. Imported
// here so the same-origin OS render inherits the OS look (.sb-* classes AppShell emits).
import '@/lib/app-ui/theme.css';
import { createOsClient } from '@/lib/app-sdk/index.ts';
import type { Role } from '@/lib/core/session.ts';
import { ROLES } from '@/lib/core/session.ts';
import type { AppSpec } from '@/lib/software/appspec/schema.ts';
import { AppSpecRenderer, type RendererIdentity } from '@/components/software/appspec/AppSpecRenderer.tsx';

/** Coerce an unknown role string from the session route to a Role, else null. */
function asRole(raw: unknown): Role | null {
  return typeof raw === 'string' && (ROLES as readonly string[]).includes(raw) ? (raw as Role) : null;
}

/**
 * `ServedAppSpec` — the CLIENT wrapper the same-origin `/apps/<slug>` route renders for a
 * `serveMode: 'spec'` app. It builds a SAME-ORIGIN governed `os` client (no `baseUrl` → every
 * `/api/*` call rides the current OS session cookie), resolves the viewer's role, and hands the
 * validated spec to the trusted `<AppSpecRenderer>`.
 *
 * Identity: seeded with the server-resolved role (passed as `initialRole`) so the first paint
 * already gates correctly (no flash of "signed-out"); then confirmed once via `os.whoami()` in
 * case the session changed. Real enforcement stays server-side at the data layer — this only
 * drives the advisory section gating.
 */
export default function ServedAppSpec({
  slug,
  spec,
  initialRole,
}: {
  slug: string;
  spec: AppSpec;
  initialRole: Role | null;
}) {
  // Same-origin governed client, carrying the app slug so os.records.* + the app's context feed
  // resolve to THIS app (see createOsClient). No baseUrl ⇒ same-origin, credentials:'include'.
  // TODO(appspec-grant-scope): the dataset/metric reads this client issues are same-origin, so
  // the app-grant INTERSECTION (checkAppGrant, audit F2) does NOT apply — a shared spec app shows
  // the viewer everything THEY can see among its sources, not a grant-narrowed subset. Phase-4:
  // thread the app slug into those reads so checkAppGrant narrows them here too (see DESIGN.md).
  const os = useMemo(() => createOsClient({ appSlug: slug }), [slug]);

  const [identity, setIdentity] = useState<RendererIdentity>({ role: initialRole });

  useEffect(() => {
    let live = true;
    os.whoami()
      .then((me) => {
        if (live) setIdentity({ role: asRole(me.user?.role) });
      })
      .catch(() => {
        // whoami failed (transient / just signed out) — keep the server-seeded role rather than
        // dropping to locked; the data layer still enforces. No crash.
      });
    return () => {
      live = false;
    };
  }, [os]);

  return <AppSpecRenderer spec={spec} os={os} identity={identity} />;
}
