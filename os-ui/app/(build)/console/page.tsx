/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */

/**
 * Console — merged Shell + Query operator tab (admin-only).
 *
 * Replaces the former separate Terminal (/terminal) and Query (/admin-query) nav
 * tabs. The old routes redirect here. This page hosts both surfaces under a single
 * Shell | Query segmented control; each panel renders the existing page component
 * without modification to its internals.
 *
 * Access: builder+ for the page (the governed Query surface — SQL over Trino/Cube,
 * OPA/RLS-checked per-caller, audited). The raw Shell sub-panel is admin-only and
 * is gated inside ConsoleClient (and independently by the terminal broker's own
 * TERMINAL_ALLOWED_ROLES + the /api/terminal/token role check). The Query API
 * (/api/admin-query) enforces the same builder+ gate server-side.
 */

import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/core/auth';
import { roleAtLeast } from '@/lib/core/session';
import ConsoleClient from './ConsoleClient';

export const dynamic = 'force-dynamic';

export default async function ConsolePage() {
  const user = await currentUser();
  if (!user || !roleAtLeast(user.role, 'builder')) {
    redirect('/');
  }
  // The client decides which surfaces to render from the caller's role: everyone
  // builder+ gets Query; only admins get the raw Shell.
  return <ConsoleClient canShell={user.role === 'admin'} />;
}
