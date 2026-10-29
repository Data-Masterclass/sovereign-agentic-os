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
 * SECRETS RULE: the master key is used server-side only, passed in by the route
 * from `config` — it is never logged, returned, or included in any result.
 *
 * Injectable fetch → unit-testable without a live gateway.
 */

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

export type GatewayOpts = {
  url: string;
  masterKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

async function call(opts: GatewayOpts, path: string, init?: RequestInit): Promise<Response> {
  const f = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 4000);
  try {
    return await f(`${opts.url}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${opts.masterKey}`,
        accept: 'application/json',
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
      },
      cache: 'no-store',
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** The live rows for one alias, or null when the gateway is unreachable. */
export async function gatewayRowsFor(alias: string, opts: GatewayOpts): Promise<GatewayModelRow[] | null> {
  try {
    const res = await call(opts, '/model/info');
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: GatewayModelRow[] };
    return (data?.data ?? []).filter((r) => r.model_name === alias);
  } catch {
    return null;
  }
}

/**
 * Remove an ADMIN-ADDED model from the LiteLLM gateway. Verifies via `/model/info`
 * that EVERY deployment row under the alias is DB-registered (`db_model === true`)
 * before calling `/model/delete` per row id — a config-seeded alias is refused as
 * `managed`, server-side, regardless of what any UI shows.
 */
export async function removeGatewayModel(alias: string, opts: GatewayOpts): Promise<GatewayRemoveResult> {
  const rows = await gatewayRowsFor(alias, opts);
  if (rows === null) return { status: 'unreachable' };
  if (rows.length === 0) return { status: 'not-found' };
  if (rows.some((r) => r.model_info?.db_model !== true)) return { status: 'managed' };

  const ids = [...new Set(rows.map((r) => r.model_info?.id).filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (ids.length === 0) return { status: 'failed' }; // db rows without ids — cannot address the delete
  for (const id of ids) {
    try {
      const res = await call(opts, '/model/delete', { method: 'POST', body: JSON.stringify({ id }) });
      if (!res.ok) return { status: 'failed' };
    } catch {
      return { status: 'failed' };
    }
  }
  return { status: 'removed', ids };
}
