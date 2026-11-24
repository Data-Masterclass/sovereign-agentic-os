/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        admin
 * FEATURE:    Short address /litellm → /tools/litellm/ (Platform → Tool consoles)
 * USER STORY: As a platform admin I type <domain>/litellm to open the LiteLLM admin console.
 * ARCHITECTURE: thin; 308 only while the console is switched on and the caller is an admin, else
 *             404 (tabs/admin/lib/tool-console-routes.ts). The public Model Hub keeps its own
 *             address (/tools/litellm/public/…). See docs/ops/tool-consoles.md.
 */
import { shortAddressResponse } from '@tabs/admin/lib/tool-console-routes';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return shortAddressResponse(req, 'litellm');
}
