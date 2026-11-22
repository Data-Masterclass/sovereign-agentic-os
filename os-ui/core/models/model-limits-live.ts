/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       core / models
 * FEATURE:    Keeps the held catalog limits current: `/model/info` (limits) + `/router/settings` (which
 *             model each role stands for), read from LiteLLM at most once a minute.
 * USER STORY: As a platform admin I remap `sovereign-strong` to another model and, within a minute and
 *             with no restart, input and output sizing follow that model's own limits.
 * ARCHITECTURE:
 *   - A read that fails KEEPS the last good table (a run is not stopped by a gateway blip) and logs a
 *     warning — never silently. With nothing ever read, the built-in defaults apply, also with a warning.
 *   - Server-only (the reads use the master key). Callers: the run starts (`agent-loop`, `runtime`,
 *     the agent graph), before they ask `modelContext()`.
 */
import 'server-only';
import { readModels, readRouterAliases, type Fetched, type LiteLlmModelRow } from '@core/infra/litellm-admin';
import { buildCatalogLimits, setCatalogLimits } from '@core/models/model-limits';

const TTL_MS = 60_000;

export type ModelLimitsIo = { models: () => Promise<Fetched<LiteLlmModelRow[]>>; aliases: () => Promise<Fetched<Record<string, string>>> };
const liveIo: ModelLimitsIo = { models: readModels, aliases: readRouterAliases };

let lastOkAt = 0;
let lastFailAt = 0;
let inflight: Promise<void> | null = null;

/** Tests only. */
export function __resetModelLimitsClock(): void {
  lastOkAt = 0;
  lastFailAt = 0;
  inflight = null;
}

async function load(io: ModelLimitsIo): Promise<void> {
  const [m, a] = await Promise.all([io.models(), io.aliases()]);
  if (!m.ok || !a.ok) {
    lastFailAt = Date.now();
    const why = !m.ok ? `/model/info: ${m.error}` : `router settings: ${(a as { error: string }).error}`;
    console.warn(`[models] could not read the model limits from LiteLLM (${why}); the last known limits (or the built-in defaults) stay in force.`);
    return;
  }
  setCatalogLimits(buildCatalogLimits(m.data, a.data));
  lastOkAt = Date.now();
}

/** Make the held limits no older than a minute (a failed read is retried after the same minute). */
export async function ensureModelLimitsFresh(io: ModelLimitsIo = liveIo): Promise<void> {
  const now = Date.now();
  if (now - lastOkAt < TTL_MS || now - lastFailAt < TTL_MS) return;
  inflight ??= load(io).finally(() => { inflight = null; });
  await inflight;
}
