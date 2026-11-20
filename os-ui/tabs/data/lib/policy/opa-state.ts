/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Restore the Data tab's OPA state (governed tables + every principal) from the registry.
 * USER STORY: As a member of any domain I want my domain principal and my datasets' governance back
 *             in OPA within one reconcile tick of an OPA restart, without anyone re-running a build.
 * ARCHITECTURE:
 *   - The OPA state SOURCE for `core/policy/opa-reconcile.ts`, registered from `instrumentation.ts`.
 *   - Re-derives the bundle with the SAME compiler a build uses (`compileOpa`) over every live
 *     dataset and the user roster, plus a self-principal for every domain (`extraDomains`, injected
 *     because the domain registry belongs to the Admin tab), and writes it with the same
 *     `governanceWrites` the build's push uses.
 */
import 'server-only';
import { publishOpaAll } from '@core/policy/opa-publish';
import type { OpaSourceResult } from '@core/policy/opa-reconcile';
import { compileOpa } from '@tabs/data/lib/policy/compiler';
import { governanceWrites } from '@tabs/data/lib/policy/opa-state-writes';
import { ensureHydrated, listAllDatasets } from '@tabs/data/lib/store';
import { buildRoster } from '@tabs/data/lib/build/live-clients';

export async function restoreDataGovernance(extraDomains: () => Promise<string[]>): Promise<OpaSourceResult> {
  await ensureHydrated();
  const roster = await buildRoster();
  const domains = new Set(await extraDomains());
  for (const p of Object.values(roster)) for (const d of p.domains) domains.add(d);
  const bundle = compileOpa(listAllDatasets(), roster, [...domains]);
  const r = await publishOpaAll(governanceWrites(bundle));
  if (!r.ok) return { ok: false, detail: r.detail };
  return {
    ok: true,
    detail: `${Object.keys(bundle.tables).length} table(s), ${Object.keys(bundle.principals).length} principal(s)`,
  };
}
