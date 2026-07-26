/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { redirect } from 'next/navigation';

/**
 * Nav consolidation: the /users tab was removed — Users & Access lives in Admin (/platform → Users & Access).
 * This stub keeps old links/bookmarks from 404ing. The target enforces its own
 * role gate; the backing API routes under /api are unchanged.
 */
export default function RemovedTabRedirect() {
  redirect('/platform');
}
