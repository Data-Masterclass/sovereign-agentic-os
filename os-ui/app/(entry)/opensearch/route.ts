/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        admin
 * FEATURE:    Short address /opensearch → /tools/opensearch/ (Platform → Tool consoles)
 * USER STORY: As a platform admin I will type <domain>/opensearch to open OpenSearch Dashboards
 *             once it can be served under /tools; until then the address answers 404.
 * ARCHITECTURE: thin; 308 only while the console is switched on, servable here (OpenSearch
 *             Dashboards is pending an owner decision) and the caller is an admin, else 404
 *             (tabs/admin/lib/tool-console-routes.ts). See docs/ops/tool-consoles.md.
 */
import { shortAddressResponse } from '@tabs/admin/lib/tool-console-routes';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return shortAddressResponse(req, 'opensearch');
}
