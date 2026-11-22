/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Catalog partition — the Models & Providers page's "Set by the deployment" vs "Added in LiteLLM"
 * split, as a pure function (client-safe; no server imports).
 *
 * THE RULE (mirrors the server-side guard in `model-remove.ts`): a model is removable from the OS
 * only when LiteLLM says EVERY deployment under the alias is registered in its database
 * (`management === 'database'`, from `db_model` on `/model/info`). A model set by the deployment's
 * config file (`config`), or an alias served by both (`mixed`), is managed by the deployment — it
 * is changed with a deploy, not here. The input is LiteLLM's own list; the OS holds no second one.
 * Fail-safe: a row with no flag is `config` (no Remove button; the server guard would refuse anyway).
 */

export type LiveCatalogRow = { model_name: string; management?: 'config' | 'database' | 'mixed' };

export type CatalogSplit = { managed: string[]; adminAdded: string[] };

/** True when a model is registered in LiteLLM's database (removable), per THE RULE above. */
export function isAdminAdded(row: LiveCatalogRow): boolean {
  return row.management === 'database';
}

/** Partition LiteLLM's models into the two page sections, each name once, sorted. */
export function splitCatalog(liveRows: LiveCatalogRow[]): CatalogSplit {
  const rows = new Map(liveRows.map((r) => [r.model_name, r]));
  const managed: string[] = [];
  const adminAdded: string[] = [];
  for (const name of [...rows.keys()].sort()) (isAdminAdded(rows.get(name)!) ? adminAdded : managed).push(name);
  return { managed, adminAdded };
}
