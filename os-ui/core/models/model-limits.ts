/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       core / models
 * FEATURE:    The context and output limits of the catalog model a role is mapped to.
 * USER STORY: As a platform admin I map `sovereign-strong` to a model; the OS sizes input and output
 *             from that model's own limits in LiteLLM, not from numbers I set by hand.
 * ARCHITECTURE:
 *   - OWNERSHIP: the limits belong to LiteLLM (`model_info.max_input_tokens` / `max_output_tokens` in
 *     `/model/info`, https://docs.litellm.ai/docs/proxy/model_management). This module only reads
 *     them (see `model-limits-live.ts`) and keeps the last answer in memory so the synchronous
 *     `modelContext()` can use it. There is no file, no database row and no seed.
 *   - A ROLE is an alias (`router_settings.model_group_alias`) of a catalog model; the table is keyed by
 *     both, and a role's entry carries the `target` model it stands for (named in error messages).
 *   - Several deployments behind one name: the SMALLER limit wins (the safe one).
 *   - Pure: no IO, no `server-only`.
 */

export type CatalogLimit = {
  /** `max_input_tokens`: the window the OS budgets input against. Absent = the catalog has no value. */
  contextWindow?: number;
  /** `max_output_tokens` (else `max_tokens`): the most the model can produce. Absent = no value. */
  maxOutput?: number;
  /** The catalog model this name resolves to (the real model behind a role). */
  target?: string;
};

type Row = { model_name?: unknown; model_info?: Record<string, unknown> | null };

const positive = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined);

/** LiteLLM's `model_info` → limits. `max_tokens` is only the OUTPUT fallback (LiteLLM's legacy field). */
export function limitsFromModelInfo(info: Record<string, unknown> | null | undefined): CatalogLimit {
  const i = info ?? {};
  const contextWindow = positive(i.max_input_tokens);
  const maxOutput = positive(i.max_output_tokens) ?? positive(i.max_tokens);
  return { ...(contextWindow ? { contextWindow } : {}), ...(maxOutput ? { maxOutput } : {}) };
}

const smaller = (a: number | undefined, b: number | undefined): number | undefined => (a === undefined ? b : b === undefined ? a : Math.min(a, b));

/** `/model/info` rows + the alias map → a table keyed by every real model name and every alias. */
export function buildCatalogLimits(rows: Row[], aliases: Record<string, string> = {}): Record<string, CatalogLimit> {
  const real: Record<string, CatalogLimit> = {};
  for (const r of rows) {
    const name = typeof r.model_name === 'string' ? r.model_name : '';
    if (!name || Object.prototype.hasOwnProperty.call(aliases, name)) continue; // an alias row is not a model
    const l = limitsFromModelInfo(r.model_info);
    const cur = real[name];
    real[name] = cur
      ? { ...(smaller(cur.contextWindow, l.contextWindow) ? { contextWindow: smaller(cur.contextWindow, l.contextWindow) } : {}), ...(smaller(cur.maxOutput, l.maxOutput) ? { maxOutput: smaller(cur.maxOutput, l.maxOutput) } : {}) }
      : l;
  }
  const out: Record<string, CatalogLimit> = {};
  for (const [name, l] of Object.entries(real)) out[name] = { ...l, target: name };
  for (const [alias, target] of Object.entries(aliases)) {
    // An alias whose target is not in the catalog has no limits (the role is unmapped or broken): left out, so the defaults and a warning apply.
    if (real[target]) out[alias] = { ...real[target], target };
  }
  return out;
}

let table: Record<string, CatalogLimit> = {};

/** Replace the held catalog limits (the live refresh and tests call this). */
export function setCatalogLimits(next: Record<string, CatalogLimit>): void {
  table = { ...next };
}
export function resetCatalogLimits(): void {
  table = {};
}
/** True once a catalog read has put at least one entry in (so a missing entry is a real gap, not "never loaded"). */
export function catalogLoaded(): boolean {
  return Object.keys(table).length > 0;
}
/** The held limits for a model name or role, if the catalog has an entry for it. */
export function catalogLimit(name: string): CatalogLimit | undefined {
  return Object.prototype.hasOwnProperty.call(table, name) ? table[name] : undefined;
}
