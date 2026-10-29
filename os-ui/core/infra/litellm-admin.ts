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
  litellm_params?: { model?: string; api_base?: string };
  model_info?: { id?: string; mode?: string; db_model?: boolean };
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
  token?: string;
  spend?: number;
  blocked?: boolean;
  team_id?: string | null;
  user_id?: string | null;
  metadata?: Record<string, unknown> | null;
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
export const readModelGroups = () => rows<LiteLlmModelGroupRow>('/model_group/info');
export const readTeams = () => rows<LiteLlmTeamRow>('/team/list', 'teams');
export const readBudgets = () => rows<LiteLlmBudgetRow>('/budget/list', 'budgets');
/** `return_full_object` is what makes spend and alias present on each row. */
export const readKeys = () => rows<LiteLlmKeyRow>('/key/list?return_full_object=true&include_team_keys=true', 'keys');
export const readGuardrails = () => rows<LiteLlmGuardrailRow>('/guardrails/list', 'guardrails');
export const readSpendReport = () => rows<LiteLlmSpendRow>('/global/spend/report');
export const readHealthLatest = () => adminGet<LiteLlmHealthBody>('/health/latest');
export const readHealthServices = () => adminGet<unknown>('/health/services');
export const readTagActivity = () => adminGet<LiteLlmTagActivityBody>('/tag/daily/activity');
