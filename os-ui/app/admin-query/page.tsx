/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { redirect } from 'next/navigation';

/**
 * Nav consolidation: the Query tab was merged into the Console tab (/console),
 * which provides a Shell | Query switch. This stub keeps old links / bookmarks
 * from 404ing. The target enforces its own admin role gate.
 *
 * The query component logic lives in components/AdminQueryContent.tsx and is
 * embedded directly in app/console/ConsoleClient.tsx.
 */
export const dynamic = 'force-dynamic';

export default function AdminQueryRedirect() {
  redirect('/console');
}
