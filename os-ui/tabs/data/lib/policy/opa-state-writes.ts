/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The OPA writes that carry a compiled `data.governance` bundle.
 * USER STORY: As a domain member I want my domain's governed tables and my domain's own principal
 *             to be in OPA after every build and after every OPA restart, so Trino's row filters
 *             never resolve my session to zero domains.
 * ARCHITECTURE:
 *   - Pure: bundle → ordered `OpaWrite`s, used by the build's policy push and by the restore
 *     source, so both write exactly the same documents.
 *   - One PUT per table key and per principal key (an upsert), never a whole-document replace:
 *     a replace would delete the chart-seeded tables/principals and every other dataset's table.
 *   - OPA path segments split on `/` only, so a `catalog.schema.table` FQN is one key.
 */
import type { OpaWrite } from '@core/policy/opa-publish';
import type { OpaBundle } from '@tabs/data/lib/policy/compiler';

export function governanceWrites(opa: OpaBundle): OpaWrite[] {
  const writes: OpaWrite[] = [];
  for (const [fqn, meta] of Object.entries(opa.tables)) {
    writes.push({ kind: 'data', path: `governance/tables/${encodeURIComponent(fqn)}`, value: meta });
  }
  for (const [id, p] of Object.entries(opa.principals)) {
    writes.push({ kind: 'data', path: `governance/principals/${encodeURIComponent(id)}`, value: p });
  }
  return writes;
}
