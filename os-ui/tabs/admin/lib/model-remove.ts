/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Gateway model removal — the LiteLLM side of "Remove" in Models & Providers.
 *
 * THE DISCRIMINATOR: LiteLLM's `/model/info` reports `model_info.db_model` per
 * deployment row — `true` for models registered at runtime via `/model/new`
 * (persisted in the litellm Postgres DB under `store_model_in_db: true`, i.e.
 * ADMIN-ADDED), `false`/absent for rows seeded from the static `model_list` in
 * the deployment config (the chart's `sovereign-*` aliases). Config-seeded rows
 * are MANAGED BY THE DEPLOYMENT: `/model/delete` cannot remove them (they come
 * back from config on every boot), so we refuse honestly instead of pretending.
 *
 * SECRETS RULE: the master key lives ONLY in `core/infra/litellm-admin.ts` /
 * `litellm-write.ts`; this module and its route never see it (A3 MODEL-KEY, repo-wide).
 *
 * Injectable IO → unit-testable without a live gateway.
 *
 * FEATURE:    Verified removal of an admin-added model from the LiteLLM gateway.
 * USER STORY: As a platform admin I remove a model I added, and a chart-seeded alias is refused
 *             honestly instead of silently coming back on the next boot.
 * ARCHITECTURE: pure decision over two injected gateway operations (read rows, delete by id);
 *             production binds them to the one admin read/write clients.
 */
import { adminGet, type Fetched } from '@core/infra/litellm-admin';
import { adminPost } from '@core/infra/litellm-write';

export type GatewayModelRow = {
  model_name?: string;
  model_info?: { id?: string; db_model?: boolean };
};

export type GatewayRemoveResult =
  /** Every deployment row for the alias was DB-registered and is now deleted. */
  | { status: 'removed'; ids: string[] }
  /** At least one row is config-seeded (`db_model !== true`) — managed by the deployment. */
  | { status: 'managed' }
  /** The gateway responded but has no row under this alias. */
  | { status: 'not-found' }
  /** `/model/info` could not be read — we cannot verify, so nothing was deleted. */
  | { status: 'unreachable' }
  /** A `/model/delete` call was rejected by the gateway. */
  | { status: 'failed' };

/**
 * The two gateway operations this module needs, as INJECTABLE IO. Production uses the ONE admin
 * read/write clients (`core/infra/litellm-admin.ts` / `litellm-write.ts`), which hold the master key;
 * no key ever appears here or in a route (A3: the `MODEL-KEY` gate is repo-wide). Tests inject fakes.
 */
export type GatewayIo = {
  get: <T>(path: string) => Promise<Fetched<T>>;
  post: <T>(path: string, body: unknown) => Promise<Fetched<T>>;
};

export type GatewayOpts = { io?: GatewayIo };

const liveIo: GatewayIo = {
  get: (path) => adminGet(path, 4000),
  post: (path, body) => adminPost(path, body, 4000),
};

/** The live rows for one alias, or null when the gateway is unreachable. */
export async function gatewayRowsFor(alias: string, opts: GatewayOpts = {}): Promise<GatewayModelRow[] | null> {
  const io = opts.io ?? liveIo;
  const res = await io.get<{ data?: GatewayModelRow[] }>('/model/info');
  if (!res.ok) return null;
  return (res.data?.data ?? []).filter((r) => r.model_name === alias);
}

/**
 * Remove an ADMIN-ADDED model from the LiteLLM gateway. Verifies via `/model/info`
 * that EVERY deployment row under the alias is DB-registered (`db_model === true`)
 * before calling `/model/delete` per row id — a config-seeded alias is refused as
 * `managed`, server-side, regardless of what any UI shows.
 */
export async function removeGatewayModel(alias: string, opts: GatewayOpts = {}): Promise<GatewayRemoveResult> {
  const io = opts.io ?? liveIo;
  const rows = await gatewayRowsFor(alias, opts);
  if (rows === null) return { status: 'unreachable' };
  if (rows.length === 0) return { status: 'not-found' };
  if (rows.some((r) => r.model_info?.db_model !== true)) return { status: 'managed' };

  const ids = [...new Set(rows.map((r) => r.model_info?.id).filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (ids.length === 0) return { status: 'failed' }; // db rows without ids — cannot address the delete
  for (const id of ids) {
    const res = await io.post('/model/delete', { id });
    if (!res.ok) return { status: 'failed' };
  }
  return { status: 'removed', ids };
}
