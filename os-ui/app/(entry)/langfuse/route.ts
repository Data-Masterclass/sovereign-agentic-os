/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        admin
 * FEATURE:    Short address /langfuse → /tools/langfuse/ (Platform → Tool consoles)
 * USER STORY: As a platform admin I will type <domain>/langfuse to open Langfuse once it can be
 *             served under /tools; until then the address answers 404.
 * ARCHITECTURE: thin; 308 only while the console is switched on, servable here (Langfuse is
 *             pending a base-path decision) and the caller is an admin, else 404
 *             (tabs/admin/lib/tool-console-routes.ts). See docs/ops/tool-consoles.md.
 */
import { shortAddressResponse } from '@tabs/admin/lib/tool-console-routes';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return shortAddressResponse(req, 'langfuse');
}
