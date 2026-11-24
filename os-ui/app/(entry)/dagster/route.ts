/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        admin
 * FEATURE:    Short address /dagster → /tools/dagster/ (Platform → Tool consoles)
 * USER STORY: As a platform admin I type <domain>/dagster to open the read-only Dagster console.
 * ARCHITECTURE: thin; 308 only while the console is switched on and the caller is an admin, else
 *             404 (tabs/admin/lib/tool-console-routes.ts). See docs/ops/tool-consoles.md.
 */
import { shortAddressResponse } from '@tabs/admin/lib/tool-console-routes';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return shortAddressResponse(req, 'dagster');
}
