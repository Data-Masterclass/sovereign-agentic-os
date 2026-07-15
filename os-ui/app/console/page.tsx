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
 * Access: admin-only. The tab itself is minRole:admin in the sidebar (lib/tabs.ts),
 * and each underlying page + API route enforces the same gate server-side.
 */

import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/core/auth';
import ConsoleClient from './ConsoleClient';

export const dynamic = 'force-dynamic';

export default async function ConsolePage() {
  const user = await currentUser();
  if (!user || user.role !== 'admin') {
    redirect('/');
  }
  return <ConsoleClient />;
}
