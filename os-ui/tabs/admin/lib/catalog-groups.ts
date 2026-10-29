/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Catalog partition — the Models & Providers page's "Managed AI" vs "Added by
 * administrators" split, as a pure function (client-safe; no server imports).
 *
 * THE RULE (mirrors the server-side guard in lib/platform-admin/model-remove.ts):
 *   • A model seen LIVE at the gateway is administrator-added only when EVERY
 *     deployment row is DB-registered (`db_model === true` from /model/info,
 *     surfaced as `dbModel`). Config-seeded aliases are managed by the deployment.
 *   • A model known only to the governed catalog (gateway offline, or registered
 *     while the gateway was down) is administrator-added iff it carries an
 *     `endpoint` — only the add-provider/assistant wizards ever set one; the
 *     chart-seeded aliases never do.
 * Fail-safe: anything ambiguous lands in "managed" (no Remove button; the server
 * guard would refuse anyway).
 */

export type LiveCatalogRow = { model_name: string; dbModel?: boolean };
export type GovernedRow = { id: string; endpoint?: unknown };

export type CatalogSplit = { managed: string[]; adminAdded: string[] };

/** True when a model name is administrator-added (removable), per THE RULE above. */
export function isAdminAdded(
  name: string,
  live: Map<string, LiveCatalogRow>,
  governed: Map<string, GovernedRow>,
): boolean {
  const liveRow = live.get(name);
  if (liveRow) return liveRow.dbModel === true;
  return Boolean(governed.get(name)?.endpoint);
}

/** Partition the union of live + governed model names into the two page sections. */
export function splitCatalog(liveRows: LiveCatalogRow[], governedRows: GovernedRow[]): CatalogSplit {
  const live = new Map(liveRows.map((r) => [r.model_name, r]));
  const governed = new Map(governedRows.map((r) => [r.id, r]));
  const names = [...new Set([...live.keys(), ...governed.keys()])].sort();
  const managed: string[] = [];
  const adminAdded: string[] = [];
  for (const name of names) (isAdminAdded(name, live, governed) ? adminAdded : managed).push(name);
  return { managed, adminAdded };
}
