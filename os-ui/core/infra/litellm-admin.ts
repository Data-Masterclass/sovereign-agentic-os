/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * litellm-admin — the ONE typed, read-only client for LiteLLM's admin API.
 *
 * FEATURE:
 *   • One `adminGet` for every LiteLLM admin read: Bearer master key, hard
 *     timeout, no-store, and a result type instead of an exception.
 *   • Tolerant row unwrapping — LiteLLM returns bare arrays on some endpoints
 *     and `{data|keys|teams|guardrails: []}` on others, and the envelope moves
 *     between versions. One unwrapper absorbs that so callers never guess.
 *   • Typed row shapes for the eleven endpoints the OS mirrors.
 *
 * USER STORY:
 *   • As a platform admin, when the gateway is down I see "gateway unreachable",
 *     never a page that invents zeros or a 500 that hides the cause.
 *   • As a security reviewer, I can confirm the master key is reachable only
 *     from server code: this module is `server-only` and no function returns it.
 *
 * ARCHITECTURE:
 *   Lowest layer of the LiteLLM read path:
 *     litellm-admin (IO, this file)
 *       -> tabs/admin/lib/gateway-mirror (pure mapping + cache + drift)
 *         -> app/api/platform-admin/gateway (adminCtx gate)
 *           -> admin panels
 *   Every function is failure-tolerant BY DESIGN and returns `Fetched<T>`:
 *   the mirror decides what a failure means, because only it knows whether a
 *   cached answer exists. Nothing here throws, retries or logs — a read of a
 *   dependency is not an error condition for the OS.
 *   READ-ONLY on purpose: no POST/PUT/DELETE lives here. Writes to LiteLLM are
 *   Phase 3 and must go through the admin API in their own reconciler module,
 *   so that "the OS never silently mutates the gateway" stays greppable.
 */
import 'server-only';
import { config } from '@core/kernel/config';

/** A read either produced data or produced a reason. It never throws. */
export type Fetched<T> = { ok: true; data: T } | { ok: false; error: string };

/** LiteLLM lives next to us in-cluster; a slow admin read must not stall a page. */
export const DEFAULT_TIMEOUT_MS = 2500;

/** True when both a base URL and a master key are present. */
export function liteLlmConfigured(): boolean {
  return config.litellmUrl.length > 0 && config.litellmMasterKey.length > 0;
}

/**
 * GET one LiteLLM admin path. The master key goes in the Authorization header
 * and stays on the server. Returns `{ok:false}` for an unset gateway, a non-2xx,
 * a timeout or a transport error — all four are normal states, not exceptions.
 */
export async function adminGet<T>(path: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<Fetched<T>> {
  if (!liteLlmConfigured()) return { ok: false, error: 'LiteLLM is not configured' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.litellmUrl}${path}`, {
      headers: { authorization: `Bearer ${config.litellmMasterKey}`, accept: 'application/json' },
      cache: 'no-store',
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, data: (await res.json()) as T };
  } catch (e) {
    const err = e as Error;
    return { ok: false, error: err?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : (err?.message || 'fetch failed') };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull the row array out of whatever envelope LiteLLM used. Checks a bare array
 * first, then `data`, then any caller-named key. Returns `[]` rather than
 * throwing: a shape we do not recognise means "nothing to mirror", which the
 * panels render as empty, not as broken.
 */
export function unwrapRows<T>(body: unknown, ...keys: string[]): T[] {
  if (Array.isArray(body)) return body as T[];
  if (body && typeof body === 'object') {
    for (const k of ['data', ...keys]) {
      const v = (body as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as T[];
    }
  }
  return [];
}

/** Map a `Fetched` envelope to a `Fetched` row array, preserving the failure. */
async function rows<T>(path: string, ...keys: string[]): Promise<Fetched<T[]>> {
  const r = await adminGet<unknown>(path);
  return r.ok ? { ok: true, data: unwrapRows<T>(r.data, ...keys) } : r;
}

/* ---------------------------------------------------------------- row shapes */
/* Every field is optional: these mirror a THIRD-PARTY schema across versions,
 * so the mapping layer must cope with any field being absent. */

/** `/model/info` — one deployment of one alias. */
export type LiteLlmModelRow = {
  model_name?: string;
  litellm_params?: { model?: string; api_base?: string; litellm_credential_name?: string };
  /** `db_model` is true for a model registered in LiteLLM's database (UI, API, the OS wizard) and false for one set by the config file's `model_list`. */
  model_info?: { id?: string; mode?: string; db_model?: boolean; access_groups?: string[]; input_cost_per_token?: number | null; output_cost_per_token?: number | null; max_input_tokens?: number | null; max_output_tokens?: number | null; max_tokens?: number | null };
};

/**
 * `GET /credentials` — a named connection in LiteLLM's own credential store. `credential_values`
 * (the secret) is deliberately NOT part of this type: nothing in the OS may read or copy it.
 */
export type LiteLlmCredentialRow = {
  credential_name?: string;
  credential_info?: Record<string, unknown>;
};

/** `/model_group/info` — the alias group a caller actually pins. */
export type LiteLlmModelGroupRow = {
  model_group?: string;
  providers?: string[];
  mode?: string;
};

/** `/team/list` — the OS maps one team to one domain. */
export type LiteLlmTeamRow = {
  team_id?: string;
  team_alias?: string | null;
  max_budget?: number | null;
  spend?: number;
  models?: string[];
  blocked?: boolean;
};

/** `/budget/list` — budgets that exist independently of a team. */
export type LiteLlmBudgetRow = {
  budget_id?: string;
  max_budget?: number | null;
  budget_duration?: string | null;
};

/** `/key/list` — virtual keys. The OS issues one per agent and per service. */
export type LiteLlmKeyRow = {
  key_alias?: string | null;
  /** LiteLLM's id for the key: the SHA-256 of its value. Never the value. */
  token?: string;
  max_budget?: number | null;
  spend?: number;
  blocked?: boolean;
  team_id?: string | null;
  user_id?: string | null;
  metadata?: Record<string, unknown> | null;
  /** When LiteLLM stops accepting the key (ISO time), or null for no expiry. */
  expires?: string | null;
};

/** `/guardrails/list` — PII and safety scanners at the gateway edge. */
export type LiteLlmGuardrailRow = {
  guardrail_name?: string;
  litellm_params?: { guardrail?: string; mode?: string; default_on?: boolean; fail_open?: boolean };
};

/** `/health/latest` — per-deployment health, split into two arrays. */
export type LiteLlmHealthBody = {
  healthy_endpoints?: { model?: string; model_name?: string }[];
  unhealthy_endpoints?: { model?: string; model_name?: string; error?: string }[];
};

/** `/global/spend/report` — spend grouped by whatever dimension was asked for. */
export type LiteLlmSpendRow = {
  user_id?: string | null;
  customer_id?: string | null;
  team_id?: string | null;
  api_key?: string | null;
  spend?: number;
};

/** `/tag/daily/activity` — spend per tag. The OS tags `domain:`, `agent:`, `tab:`. */
export type LiteLlmTagActivityBody = {
  results?: { tag?: string; metrics?: { spend?: number } }[];
};

/* -------------------------------------------------------------------- reads */

export const readModels = () => rows<LiteLlmModelRow>('/model/info');
/**
 * LiteLLM's `router_settings.model_group_alias` (`GET /router/settings` → `current_values`). LiteLLM 1.109.1
 * also LISTS every alias as a `db_model: true` row in `/model/info`, so the model catalog needs this to tell
 * a real model from an alias of one.
 */
export async function readRouterAliases(): Promise<Fetched<Record<string, string>>> {
  const r = await adminGet<{ current_values?: { model_group_alias?: Record<string, string> | null } }>('/router/settings', 6000);
  if (!r.ok) return r;
  return { ok: true, data: { ...(r.data.current_values?.model_group_alias ?? {}) } };
}
export const readCredentials = () => rows<LiteLlmCredentialRow>('/credentials', 'credentials');
export const readModelGroups = () => rows<LiteLlmModelGroupRow>('/model_group/info');
export const readTeams = () => rows<LiteLlmTeamRow>('/team/list', 'teams');
/** `return_full_object` is what makes spend and alias present on each row. */
export const readKeys = () => readAllKeys();

/** `/key/list` is PAGED (10 per page by default, 100 at most). A page limit that is hit is reported, never truncated silently. */
const KEY_PAGE_SIZE = 100;
const KEY_MAX_PAGES = 100;

/**
 * EVERY virtual key the gateway holds, page by page. A failure on any page fails the whole read:
 * a partial list would let a caller conclude "that key does not exist" from a page it never saw.
 */
export async function readAllKeys(get: typeof adminGet = adminGet): Promise<Fetched<LiteLlmKeyRow[]>> {
  const all: LiteLlmKeyRow[] = [];
  for (let page = 1; page <= KEY_MAX_PAGES; page += 1) {
    const r = await get<unknown>(`/key/list?return_full_object=true&include_team_keys=true&size=${KEY_PAGE_SIZE}&page=${page}`, 8000);
    if (!r.ok) return r;
    const batch = unwrapRows<LiteLlmKeyRow>(r.data, 'keys');
    all.push(...batch);
    const totalPages = Number((r.data as { total_pages?: unknown } | null)?.total_pages);
    if (batch.length < KEY_PAGE_SIZE || (Number.isFinite(totalPages) && page >= totalPages)) return { ok: true, data: all };
  }
  return { ok: false, error: `more than ${KEY_PAGE_SIZE * KEY_MAX_PAGES} keys — listing stopped` };
}
export const readGuardrails = () => rows<LiteLlmGuardrailRow>('/guardrails/list', 'guardrails');
export const readSpendReport = () => rows<LiteLlmSpendRow>('/global/spend/report');
export const readHealthLatest = () => adminGet<LiteLlmHealthBody>('/health/latest');
export const readTagActivity = () => adminGet<LiteLlmTagActivityBody>('/tag/daily/activity');
