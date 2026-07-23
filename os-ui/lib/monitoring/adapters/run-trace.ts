/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/core/config';
import { recentTraces } from '@/lib/infra/agent-governed';
import { readFetch } from '../util';
import { MOCK_RUNS, mockTrace } from '../mock';
import type { Health, HealthItem, TraceDetail, TraceStep } from '../types';

/**
 * Run/trace adapter (lens 1) — Langfuse runs + the in-process governed trace ring,
 * plus the drill-into-trace (steps · tool calls · context pack · in/out · logs).
 * READ-ONLY. Live where Langfuse is up; offline-mock otherwise (honest `source`).
 *
 * REUSE: the same `recentTraces()` ring buffer `lib/agent-governed.ts` already
 * fills on every governed tool call — so a run shows here even with no live
 * Langfuse — and Langfuse's own public traces API when it is reachable.
 */

function runHealth(t: { decision?: string; output?: unknown }): Health {
  const out = typeof t.output === 'string' ? t.output : JSON.stringify(t.output ?? '');
  if (t.decision === 'deny' || /error|fail|aborted/i.test(out)) return 'red';
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
      const owner = String(meta.principal ?? 'unknown');
      return {
        id: String(t.id ?? ''),
        lens: 'runs',
        title: String(t.name ?? 'run'),
        health: runHealth({ decision: meta.decision as string, output: t.output }),
        detail: preview(t.output),
        owner,
        domain: String(meta.domain ?? principalDomain(owner)),
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
      return {
        id: String(t.id ?? id),
        name: String(t.name ?? 'run'),
        owner: String(meta.principal ?? 'unknown'),
        domain: String(meta.domain ?? principalDomain(String(meta.principal ?? ''))),
        health: /error|fail/i.test(preview(t.output)) ? 'red' : 'green',
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

/** True when an observation recorded an error (Langfuse level or an error output). */
function obsError(o: Record<string, unknown>): boolean {
  if (String(o.level ?? '').toUpperCase() === 'ERROR') return true;
  return /error|fail|aborted/i.test(preview(o.output) + ' ' + preview(o.statusMessage));
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
