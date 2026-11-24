/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Tool consoles — does a console's upstream answer at its in-cluster address?
 * USER STORY: As a platform admin I see "available" next to a tool console only when the tool
 *             actually answered just now, and "not set up on this install" otherwise.
 * ARCHITECTURE:
 *   - The one network door for Platform → Tool consoles (tabs/admin/lib/tool-consoles.ts).
 *     `readHttp` (design 00 §6) does the request; ANY HTTP answer counts as "answered" (a console
 *     root may well say 401, 404 or 307), a transport error or a timeout does not.
 *   - `dagsterReadOnlyUpstream()` is the read-only Dagster webserver's address (DAGSTER_READONLY_URL),
 *     the upstream of the /tools/dagster console, read here so component addresses stay in adapters.
 */
import { config } from '@core/kernel/config';
import type { Fetched } from '../_contract';
import { failed, fetched, readHttp } from './http';

export const CONSOLE_PROBE_TIMEOUT_MS = 2_000;

/** `ok` with the answer when the upstream answered at all; the transport failure otherwise. */
export async function probeConsole(url: string, timeoutMs = CONSOLE_PROBE_TIMEOUT_MS): Promise<Fetched<{ answered: true; detail: string }>> {
  if (!url) return failed('not_found', 'no address configured');
  const r = await readHttp(url, { timeoutMs });
  if (r.ok) return fetched({ answered: true, detail: `answered ${r.value.status}` });
  if (r.reason === 'invalid' || r.reason === 'unauthorized' || r.reason === 'forbidden') {
    return fetched({ answered: true, detail: r.detail });
  }
  return r as Fetched<{ answered: true; detail: string }>;
}

/** The read-only Dagster webserver's ORIGIN (empty ⇒ not rendered on this install). */
export function dagsterReadOnlyUpstream(): string {
  return config.dagsterReadOnlyUrl;
}
