/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { recentTraces } from '@core/infra/agent-governed';
import { readFetch } from '@tabs/monitoring/lib/util';
import { MOCK_RUNS, mockTrace } from '@tabs/monitoring/lib/mock';
import type { Health, HealthItem, TraceDetail, TraceStep } from '@tabs/monitoring/lib/types';

/**
 * Run/trace adapter (lens 1) — Langfuse runs + the in-process governed trace ring,
 * plus the drill-into-trace (steps · tool calls · context pack · in/out · logs).
 * READ-ONLY. Live where Langfuse is up; offline-mock otherwise (honest `source`).
 *
 * REUSE: the same `recentTraces()` ring buffer `lib/agent-governed.ts` already
 * fills on every governed tool call — so a run shows here even with no live
 * Langfuse — and Langfuse's own public traces API when it is reachable.
 *
 * X-R3/X-R4 — WHY FAILURE IS READ STRUCTURALLY AND NOT BY GREP. Every "did this
 * step fail" question used to be answered by running /error|fail|aborted/i over
 * `JSON.stringify(output)`. The observer's own payloads defeat that: a SUCCESSFUL
 * tool span's output is `{"isError":false,…}` (the KEY NAME contains "error") and
 * `run.result`'s output is `{"failed":false,…}` (the key name contains "fail"), so
 * on production 0.8.0 EVERY tool span read back as `status: 'error'` and every
 * successful run read back red. The fix is to read what the writer actually wrote:
 * Langfuse's own `level`, and the boolean fields `isError` / `failed`. The text
 * probe survives only for a genuinely TEXTUAL output, where a word is a word.
 */

/** The error-ish booleans the OS's own span payloads carry, read by name. */
function flaggedFailure(output: unknown): boolean | null {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
  const o = output as Record<string, unknown>;
  // `isError` is the tool-result flag; `failed` is `run.result`'s outcome flag. A present
  // boolean is AUTHORITATIVE in both directions — `false` means success, and must not be
  // overridden by a text probe that matched its own key name.
  if (typeof o.isError === 'boolean') return o.isError;
  if (typeof o.failed === 'boolean') return o.failed;
  return null;
}

/** True when a TEXT output reads as a failure. Only applied to strings (see the header). */
function textReadsAsFailure(output: unknown): boolean {
  return typeof output === 'string' && /error|fail|aborted/i.test(output);
}

/**
 * Did this observation/trace fail? Structured first (`level`, then the boolean flags), text last.
 * Exported for the X-R3 test, which drives the exact payloads the observer writes.
 */
export function outputFailed(output: unknown, level?: unknown): boolean {
  const lv = String(level ?? '').toUpperCase();
  if (lv === 'ERROR') return true;
  const flagged = flaggedFailure(output);
  if (flagged !== null) return flagged;
  return textReadsAsFailure(output);
}

function runHealth(t: { decision?: string; output?: unknown; level?: unknown }): Health {
  if (t.decision === 'deny' || outputFailed(t.output, t.level)) return 'red';
  if (t.decision === 'requires_approval') return 'amber';
  return 'green';
}

/**
 * Collect recent runs. Owner/domain are derived from the trace metadata where
 * present (principal → owner; the principal's domain → domain); the offline ring
 * is tagged best-effort. Scope filtering happens centrally in aggregate.
 */
export async function collectRuns(): Promise<HealthItem[]> {
  // 1) In-process governed ring (always available; reflects this process's runs).
  const ring = recentTraces(50).map<HealthItem>((r) => ({
    id: r.id,
    lens: 'runs',
    title: `${r.principal} — ${r.tool}`,
    health: runHealth(r),
    detail: `${r.runtime === 'hermes' ? 'hermes · ' : ''}${r.decision ?? 'run'}${r.costUsd ? ` · $${r.costUsd.toFixed(3)}` : ''}${r.landed ? '' : ' · (not in Langfuse)'}`,
    owner: r.principal,
    domain: principalDomain(r.principal),
    ts: r.timestamp,
    metric: r.costUsd,
    links: { runId: r.id },
    source: 'live',
  }));

  // 2) Langfuse public traces (richer history when the service is up).
  const lf = await langfuseRuns();

  const merged = [...lf, ...ring];
  // 3) Offline mock — only when nothing live was found AND demo fixtures are on
  // (dev/test). A real deploy with no runs yet shows an honest empty list.
  if (merged.length === 0) return config.monitoringDemoFixtures ? [...MOCK_RUNS] : [];
  return merged;
}

async function langfuseRuns(): Promise<HealthItem[]> {
  const auth = Buffer.from(`${config.langfusePublicKey}:${config.langfuseSecretKey}`).toString('base64');
  const res = await readFetch(`${config.langfuseUrl}/api/public/traces?limit=25`, {
    headers: { authorization: `Basic ${auth}`, accept: 'application/json' },
  });
  if (!res || !res.ok) return [];
  try {
    const data = JSON.parse(await res.text());
    const rows = Array.isArray(data?.data) ? data.data : [];
    return rows.map((t: Record<string, unknown>): HealthItem => {
      const meta = (t.metadata ?? {}) as Record<string, unknown>;
      const owner = traceOwner(t, meta);
      return {
        id: String(t.id ?? ''),
        lens: 'runs',
        title: String(t.name ?? 'run'),
        health: runHealth({ decision: meta.decision as string, output: t.output }),
        detail: preview(t.output),
        owner,
        domain: traceDomain(meta, owner),
        ts: (t.timestamp as string) ?? undefined,
        links: { runId: String(t.id ?? '') },
        source: 'live',
      };
    });
  } catch {
    return [];
  }
}

/** Drill into ONE trace (the core promise). Live Langfuse first, then mock. */
export async function fetchTrace(id: string): Promise<TraceDetail | null> {
  const auth = Buffer.from(`${config.langfusePublicKey}:${config.langfuseSecretKey}`).toString('base64');
  const res = await readFetch(`${config.langfuseUrl}/api/public/traces/${encodeURIComponent(id)}`, {
    headers: { authorization: `Basic ${auth}`, accept: 'application/json' },
  });
  if (res && res.ok) {
    try {
      const t = JSON.parse(await res.text()) as Record<string, unknown>;
      const meta = (t.metadata ?? {}) as Record<string, unknown>;
      const obs = Array.isArray(t.observations) ? (t.observations as Record<string, unknown>[]) : [];
      const steps: TraceStep[] = obs.map((o) => ({
        name: String(o.name ?? 'step'),
        kind: (o.type === 'GENERATION' ? 'llm' : o.type === 'SPAN' ? 'span' : 'tool') as TraceStep['kind'],
        input: preview(o.input),
        output: preview(o.output),
        tokens: numOrUndef((o.usage as Record<string, unknown>)?.total) ?? numOrUndef(o.totalTokens),
        ms: numOrUndef(o.latency),
        status: obsError(o) ? 'error' : 'ok',
      }));
      const owner = traceOwner(t, meta);
      return {
        id: String(t.id ?? id),
        name: String(t.name ?? 'run'),
        owner,
        domain: traceDomain(meta, owner),
        health: outputFailed(t.output) ? 'red' : 'green',
        ts: (t.timestamp as string) ?? undefined,
        contextPack: contextPackFrom(t, obs),
        steps,
        logs: logsFrom(t, obs),
        links: { runId: String(t.id ?? id) },
        source: 'live',
      };
    } catch {
      /* fall through to mock */
    }
  }
  return mockTrace(id);
}

/**
 * The CONTEXT PACK handed to the run — the packed context messages the LLM saw.
 * Verified against the live Langfuse shape: a GENERATION observation's
 * `input.messages` is an array of {role, content} — that IS the assembled context
 * (system prompt + retrieved passages + the task). We surface each message as one
 * "role: content" line. Governed traces (agent.*) carry NO observations but do carry
 * a trace-level `input` (the tool's request payload) — we fall back to that so the
 * pack is never empty when context genuinely exists.
 */
function contextPackFrom(t: Record<string, unknown>, obs: Record<string, unknown>[]): string[] {
  // 1) The richest source: the first generation step's input messages.
  const gen = obs.find((o) => o.type === 'GENERATION' && o.input != null);
  const msgs = (gen?.input as Record<string, unknown> | undefined)?.messages;
  if (Array.isArray(msgs) && msgs.length > 0) {
    return msgs.map((m) => {
      const role = String((m as Record<string, unknown>).role ?? 'msg');
      return `${role}: ${preview((m as Record<string, unknown>).content, 400)}`;
    });
  }
  // 2) Governed trace with no observations — the trace input is the packed request.
  const packed = preview(t.input, 600);
  if (packed) return [packed];
  // 3) Nothing to pack (e.g. a run with no recorded input) — honest empty.
  return [];
}

/**
 * Log-like lines for the run. Langfuse has no discrete log stream, but each
 * observation IS a structured log event; we render one line per observation
 * (time · type · name · status · latency · tokens) plus a final trace summary,
 * exactly what an operator scans. When there are no observations we still emit the
 * trace-level start/decision line from the metadata so the tail is never blank for
 * a real run. If the trace carried a genuine log field we'd prefer it; Langfuse
 * does not expose one, so these derived lines are the honest best available.
 */
function logsFrom(t: Record<string, unknown>, obs: Record<string, unknown>[]): string[] {
  const lines: string[] = [];
  for (const o of obs) {
    const ts = String(o.startTime ?? o.createdAt ?? '');
    const type = String(o.type ?? 'EVENT');
    const name = String(o.name ?? 'step');
    const level = obsError(o) ? 'ERROR' : String(o.level ?? 'INFO').toUpperCase();
    const ms = numOrUndef(o.latency);
    const toks = numOrUndef((o.usage as Record<string, unknown>)?.total) ?? numOrUndef(o.totalTokens);
    const status = String(o.statusMessage ?? '').trim();
    const extras = [
      ms != null ? `${ms}ms` : '',
      toks != null ? `${toks}tok` : '',
      status ? `msg="${preview(status, 80)}"` : '',
    ]
      .filter(Boolean)
      .join(' ');
    lines.push(`${ts} ${level} ${type.toLowerCase()}.${name}${extras ? ` ${extras}` : ''}`.trim());
  }
  const meta = (t.metadata ?? {}) as Record<string, unknown>;
  const decision = meta.decision ?? meta.tool;
  if (lines.length === 0 && (t.timestamp || decision)) {
    // No observations (governed trace) — one honest summary line from the metadata.
    lines.push(
      `${String(t.timestamp ?? '')} INFO ${String(t.name ?? 'run')}${
        meta.principal ? ` principal=${meta.principal}` : ''
      }${decision ? ` decision=${decision}` : ''}`.trim(),
    );
  }
  return lines;
}

/**
 * True when an observation recorded an error. X-R3: structured signals only — Langfuse's `level`,
 * then the payload's own `isError` / `failed` boolean. `statusMessage` counts only when it is
 * actually set, because the observer writes it ONLY on a failure (or on `parked on approval`,
 * which is neither an error nor silent — it is reported as the parked span it is).
 */
function obsError(o: Record<string, unknown>): boolean {
  if (outputFailed(o.output, o.level)) return true;
  const msg = String(o.statusMessage ?? '').trim();
  return msg.length > 0 && /error|fail|aborted/i.test(msg);
}

/**
 * Who ran this trace. X-R4: `get_run_trace` answered `owner: 'unknown'` for every agent run,
 * because the header only ever read `metadata.principal` — a field the GOVERNED-tool traces set
 * and the AGENT-run observer does not. The observer writes the acting user to the trace's own
 * `userId` (`trace({ userId: input.userId, … })`), which is the authoritative field for exactly
 * this. Read it, then the governed-trace metadata, and only then say `unknown` — which now means
 * "the trace really records nobody", not "we looked in one place".
 *
 * Order matters: `metadata.principal` is the DELEGATED principal of a governed tool call and is
 * preferred where it exists; `userId` is the fallback for an agent run.
 */
export function traceOwner(t: Record<string, unknown>, meta: Record<string, unknown>): string {
  const first = [meta.principal, t.userId, meta.userId]
    .map((v) => String(v ?? '').trim())
    .find((v) => v.length > 0);
  return first ?? 'unknown';
}

/**
 * Which domain owns this trace. X-R4: the header showed an EMPTY domain whenever the observer's
 * `metadata.domain` was present but blank (an unassigned system) — `??` only guards `undefined`,
 * so `''` passed straight through and the scope gate compared against nothing. Falls back to the
 * owner's domain, then to `unknown`; never returns an empty string.
 */
export function traceDomain(meta: Record<string, unknown>, owner: string): string {
  const declared = String(meta.domain ?? '').trim();
  if (declared) return declared;
  const derived = principalDomain(owner).trim();
  return derived || 'unknown';
}

/** Map a principal to its domain. Sales-family principals → 'sales' (worked example). */
function principalDomain(principal: string): string {
  const p = principal.toLowerCase();
  if (p.includes('sales')) return 'sales';
  if (p.includes('finance')) return 'finance';
  if (p.includes('churn')) return 'sales';
  return principal || 'unknown';
}

function preview(v: unknown, max = 160): string {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function numOrUndef(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
