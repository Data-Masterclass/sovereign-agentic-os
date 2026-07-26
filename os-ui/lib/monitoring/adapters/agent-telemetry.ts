/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/core/config';
import { recentTraces, type TraceRecord } from '@/lib/infra/agent-governed';
import { principalFor } from '@/lib/agents/build/runtime-contract';
import { readFetch } from '../util';
import { type RawRun, type RunHealth } from '../telemetry-core';

/**
 * Agent telemetry adapter — the REAL per-agent-system run history for the Monitor
 * tiles + detail window. A system with id `S` traces to Langfuse (and the governed
 * ring) under principal `os-S` (or `os-S:<node>` per sub-agent). We pull the last 7
 * days of traces for that principal prefix and normalise them to `RawRun`, which the
 * pure rollup then folds into cost/tokens/runs/last-run/warnings/errors.
 *
 * TWO real sources, no fake path:
 *   1) Langfuse public traces API — the durable history (cost/tokens/time/errors).
 *   2) The in-process governed ring (`recentTraces`) — this process's runs, so a
 *      just-run agent shows even before Langfuse is queried / when it is down.
 * If BOTH are empty the tile honestly shows "no telemetry yet" (runs===0); we only
 * fall to fixtures when `config.monitoringDemoFixtures` is on (dev/test), never prod.
 */

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** A richer per-run row for the detail window (superset of `RawRun`). */
export type AgentRunRecord = RawRun & {
  name: string;
  model?: string;
  decision?: string;
  ms?: number;
  source: 'live' | 'ring' | 'mock';
};

export type AgentTelemetryResult = {
  runs: AgentRunRecord[];
  /** How the runs were sourced — drives the honest "no telemetry"/"mock" marker. */
  source: 'langfuse' | 'ring' | 'mixed' | 'none' | 'mock';
  /** True when Langfuse was reachable this call (else we only had the ring). */
  langfuseReachable: boolean;
};

/** Does this trace's principal belong to agent system `systemId`? */
function belongsToSystem(principal: string, systemId: string): boolean {
  const base = principalFor(systemId); // `os-<id>`
  return principal === base || principal.startsWith(`${base}:`);
}

/** Verdict for one trace/step. Deny/error output → error; requires_approval → warn. */
function verdictOf(decision: string | undefined, output: unknown): RunHealth {
  const out = typeof output === 'string' ? output : JSON.stringify(output ?? '');
  if (decision === 'deny' || /error|fail|aborted/i.test(out)) return 'error';
  if (decision === 'requires_approval') return 'warn';
  return 'ok';
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Map an in-process ring record → AgentRunRecord (already this-process, always fresh). */
function fromRing(r: TraceRecord): AgentRunRecord {
  return {
    id: r.id,
    at: Date.parse(r.timestamp),
    name: `agent.${r.tool}`,
    decision: r.decision,
    health: verdictOf(r.decision, r.output),
    costUsd: r.costUsd,
    tokens: r.tokens,
    source: 'ring',
  };
}

/**
 * Parse ONE Langfuse trace row into a run record (plus its principal), or null
 * for a malformed row. Langfuse rolls cost/tokens onto the trace; we accept the
 * common field names. Our own metadata comes FIRST for cost — Langfuse reports
 * totalCost 0 (not absent) for traces with no priced generations, which would
 * short-circuit `??` and pin the cost to a fake $0.
 */
function fromLangfuseRow(t: Record<string, unknown>): (AgentRunRecord & { principal: string }) | null {
  const meta = (t.metadata ?? {}) as Record<string, unknown>;
  const at = Date.parse(String(t.timestamp ?? ''));
  if (!Number.isFinite(at)) return null;
  return {
    principal: String(meta.principal ?? ''),
    id: String(t.id ?? ''),
    at,
    name: String(t.name ?? 'run'),
    model: typeof meta.model === 'string' ? meta.model : undefined,
    decision: typeof meta.decision === 'string' ? meta.decision : undefined,
    health: verdictOf(meta.decision as string | undefined, t.output),
    costUsd: num(meta.costUsd) ?? num(t.totalCost) ?? num(t.calculatedTotalCost),
    tokens: num(t.totalTokens) ?? num((t.usage as Record<string, unknown>)?.total) ?? num(meta.tokens),
    ms: num(t.latency),
    source: 'live',
  };
}

/**
 * Fetch the last-7-day Langfuse traces for one system's principal(s). Returns `null`
 * when Langfuse is unreachable (so the caller degrades to the ring honestly), or a
 * (possibly empty) array when it is reachable. We over-fetch by time window and
 * filter by principal client-side — the public list endpoint has no principal facet.
 */
async function langfuseRunsFor(systemId: string, nowMs: number): Promise<AgentRunRecord[] | null> {
  const from = new Date(nowMs - WINDOW_MS).toISOString();
  const auth = Buffer.from(`${config.langfusePublicKey}:${config.langfuseSecretKey}`).toString('base64');
  const url = `${config.langfuseUrl}/api/public/traces?limit=100&fromTimestamp=${encodeURIComponent(from)}`;
  const res = await readFetch(url, { headers: { authorization: `Basic ${auth}`, accept: 'application/json' } });
  if (!res || !res.ok) return null;
  try {
    const data = JSON.parse(await res.text());
    const rows: Record<string, unknown>[] = Array.isArray(data?.data) ? data.data : [];
    const out: AgentRunRecord[] = [];
    for (const t of rows) {
      const rec = fromLangfuseRow(t);
      if (!rec || !belongsToSystem(rec.principal, systemId)) continue;
      out.push(rec);
    }
    return out;
  } catch {
    return null;
  }
}

/** os-<id> or os-<id>:node → the base system id, or null for a non-system principal. */
function systemIdOf(principal: string): string | null {
  const m = /^os-([^:]+)(?::.*)?$/.exec(principal);
  return m ? m[1] : null;
}

/**
 * ONE Langfuse read for the whole tile grid: pull the last-7-day traces and group
 * them by owning system id (`os-<id>`). Returns `runsBySystem` (empty map when
 * Langfuse is down) plus reachability, so the tiles cost a single round-trip instead
 * of one per agent. The in-process ring is merged in per-system by the caller.
 */
export async function agentTelemetryBatch(
  nowMs: number,
): Promise<{ runsBySystem: Map<string, AgentRunRecord[]>; langfuseReachable: boolean }> {
  const from = new Date(nowMs - WINDOW_MS).toISOString();
  const auth = Buffer.from(`${config.langfusePublicKey}:${config.langfuseSecretKey}`).toString('base64');
  const url = `${config.langfuseUrl}/api/public/traces?limit=100&fromTimestamp=${encodeURIComponent(from)}`;
  const res = await readFetch(url, { headers: { authorization: `Basic ${auth}`, accept: 'application/json' } });

  const byId = new Map<string, AgentRunRecord[]>();
  const push = (sid: string, r: AgentRunRecord) => {
    const arr = byId.get(sid) ?? [];
    arr.push(r);
    byId.set(sid, arr);
  };

  // Ring first — always available, reflects this process's runs.
  const fromMs = nowMs - WINDOW_MS;
  for (const r of recentTraces(200)) {
    const sid = systemIdOf(r.principal);
    if (!sid) continue;
    const rec = fromRing(r);
    if (!Number.isFinite(rec.at) || rec.at < fromMs || rec.at > nowMs) continue;
    push(sid, rec);
  }

  let langfuseReachable = false;
  if (res && res.ok) {
    langfuseReachable = true;
    try {
      const data = JSON.parse(await res.text());
      const rows: Record<string, unknown>[] = Array.isArray(data?.data) ? data.data : [];
      for (const t of rows) {
        const rec = fromLangfuseRow(t);
        if (!rec) continue;
        const sid = systemIdOf(rec.principal);
        if (!sid) continue;
        const arr = byId.get(sid) ?? [];
        if (arr.some((x) => x.id === rec.id)) continue; // de-dupe vs ring
        arr.push(rec);
        byId.set(sid, arr);
      }
    } catch {
      /* keep ring-only */
    }
  }

  for (const [, arr] of byId) arr.sort((a, b) => b.at - a.at);
  return { runsBySystem: byId, langfuseReachable };
}

/**
 * TENANT-TOTAL run records for the last 7 days — EVERY principal (agent systems
 * `os-*` AND assistants), for the LLM Gateway spend tile. Same two real sources
 * as the Monitoring tiles (Langfuse traces + the in-process governed ring),
 * de-duped by id, so Gateway and Monitoring spend agree by construction.
 * `langfuseReachable` false + empty runs ⇒ spend is UNKNOWN, not 0.
 */
export async function tenantRuns(
  nowMs: number,
): Promise<{ runs: AgentRunRecord[]; langfuseReachable: boolean }> {
  const fromMs = nowMs - WINDOW_MS;
  const byId = new Map<string, AgentRunRecord>();

  // Ring first — always available, reflects this process's runs.
  for (const r of recentTraces(200)) {
    const rec = fromRing(r);
    if (!Number.isFinite(rec.at) || rec.at < fromMs || rec.at > nowMs) continue;
    byId.set(rec.id, rec);
  }

  const from = new Date(fromMs).toISOString();
  const auth = Buffer.from(`${config.langfusePublicKey}:${config.langfuseSecretKey}`).toString('base64');
  const url = `${config.langfuseUrl}/api/public/traces?limit=100&fromTimestamp=${encodeURIComponent(from)}`;
  const res = await readFetch(url, { headers: { authorization: `Basic ${auth}`, accept: 'application/json' } });

  let langfuseReachable = false;
  if (res && res.ok) {
    langfuseReachable = true;
    try {
      const data = JSON.parse(await res.text());
      const rows: Record<string, unknown>[] = Array.isArray(data?.data) ? data.data : [];
      for (const t of rows) {
        const rec = fromLangfuseRow(t);
        if (!rec || byId.has(rec.id)) continue; // de-dupe vs ring
        byId.set(rec.id, rec);
      }
    } catch {
      /* keep ring-only */
    }
  }

  const runs = [...byId.values()].sort((a, b) => b.at - a.at);
  return { runs, langfuseReachable };
}

/**
 * The real run history for ONE agent system over the last 7 days, newest first.
 * Merges Langfuse (durable) with the in-process ring (fresh), de-duped by id.
 */
export async function agentTelemetryFor(systemId: string, nowMs: number): Promise<AgentTelemetryResult> {
  const lf = await langfuseRunsFor(systemId, nowMs);
  const langfuseReachable = lf !== null;

  const from = nowMs - WINDOW_MS;
  const ring = recentTraces(200)
    .filter((r) => belongsToSystem(r.principal, systemId))
    .map(fromRing)
    .filter((r) => Number.isFinite(r.at) && r.at >= from && r.at <= nowMs);

  const byId = new Map<string, AgentRunRecord>();
  for (const r of lf ?? []) byId.set(r.id, r);
  for (const r of ring) if (!byId.has(r.id)) byId.set(r.id, r);
  const merged = [...byId.values()].sort((a, b) => b.at - a.at);

  let source: AgentTelemetryResult['source'];
  if (merged.length === 0) {
    source = 'none';
  } else if ((lf?.length ?? 0) > 0 && ring.length > 0) {
    source = 'mixed';
  } else if ((lf?.length ?? 0) > 0) {
    source = 'langfuse';
  } else {
    source = 'ring';
  }

  return { runs: merged, source, langfuseReachable };
}
