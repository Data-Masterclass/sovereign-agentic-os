/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { redirect } from 'next/navigation';

/**
 * Nav consolidation: the Terminal tab was merged into the Console tab (/console),
 * which provides a Shell | Query switch. This stub keeps old links / bookmarks
 * from 404ing. The target enforces its own admin role gate.
 */
export const dynamic = 'force-dynamic';

export default function TerminalRedirect() {
  redirect('/console');
}
