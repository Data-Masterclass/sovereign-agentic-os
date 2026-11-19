/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Run/trace adapter (lens 1) — the runs list and the drill-into-one-trace view
 * USER STORY: As an agent owner I want to see my runs with their real status and open one to
 *             see its steps, tool calls, context pack and logs so that I can tell why it failed.
 * ARCHITECTURE:
 *   - Server-only, read-only. Agent runs come from the durable run store (`run-store-runs`);
 *     governed tool-call traces come from the in-process ring (`recentTraces`) and Langfuse.
 *     An unreachable run store is reported as one `unknown` item, never an empty list.
 *   - `fetchTrace` reads Langfuse; the mock trace is returned only when
 *     `config.monitoringDemoFixtures` is on (off by default in production).
 *   - Failure is read structurally (Langfuse `level`, then the `isError` / `failed` / `ok` /
 *     `success` / `error` fields) and text is probed only for string values, because the
 *     payload KEY names contain "error"/"fail" and a JSON-wide grep marked every span red.
 *   - Used by `aggregate.ts`, `index.ts` and `core/mcp/monitoring-tools.ts`.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { recentTraces } from '@core/infra/agent-governed';
import { readFetch } from '@tabs/monitoring/lib/util';
import { MOCK_RUNS, mockTrace } from '@tabs/monitoring/lib/mock';
import type { Health, HealthItem, Scope, TraceDetail, TraceStep } from '@tabs/monitoring/lib/types';
import { isRunId } from '@core/kernel/run-id';
import { storeRuns, type RunListFilter, type RunListItem, type RunListSource } from '@tabs/monitoring/lib/adapters/run-store-runs';

export { isRunListStatus, RUN_LIST_STATUSES, type RunListStatus } from '@tabs/monitoring/lib/adapters/run-store-runs';

/** Words that mean "this went wrong" in a human-written status or result line. */
const FAILURE_WORDS = /error|fail|aborted|denied|refused|timed out|timeout/i;

/**
 * The outcome booleans the OS's own span payloads carry, read BY NAME. A present boolean is
 * authoritative in both directions — `false` means success and must not be overridden by a text
 * probe that matched its own key name, which is the whole defect X-R3 fixed.
 *
 * Review M-2 widened the set beyond `isError`/`failed`: an ALLOWED tool is free to return its own
 * outcome shape, and `{ ok: false, reason: 'the upstream call failed' }` read GREEN under the
 * narrow version — a worse failure mode than the original, because it is silent. `ok` is inverted
 * (`ok: false` is a failure); a non-empty `error` field is a failure whatever its type.
 */
function flaggedFailure(output: unknown): boolean | null {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
  const o = output as Record<string, unknown>;
  if (typeof o.isError === 'boolean') return o.isError;
  if (typeof o.failed === 'boolean') return o.failed;
  if (typeof o.ok === 'boolean') return !o.ok;
  if (typeof o.success === 'boolean') return !o.success;
  if (o.error != null && o.error !== '' && o.error !== false) return true;
  return null;
}

/**
 * True when the output's TEXT reads as a failure. Review M-2: this now also walks a flagless
 * object's string VALUES — never its keys, which is what the original grep over
 * `JSON.stringify(output)` effectively did. One level deep and bounded: an outcome word lives in
 * a `reason` / `message` / `detail` field, not six levels down, and an unbounded walk over a
 * large payload is a cost on every row of the runs list.
 */
function textReadsAsFailure(output: unknown): boolean {
  if (typeof output === 'string') return FAILURE_WORDS.test(output);
  if (!output || typeof output !== 'object') return false;
  const values = Array.isArray(output) ? output : Object.values(output as Record<string, unknown>);
  return values.slice(0, 50).some((v) => typeof v === 'string' && FAILURE_WORDS.test(v));
}

/**
 * Did this observation/trace fail? Structured first (`level`, then the outcome flags), text last.
 * Exported for the X-R3/M-2 tests, which drive the exact payloads the observer writes.
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

/** Whether the run store answered a listing. */
export type RunStoreState = { available: true } | { available: false; code: 'run_store_unavailable'; reason: string };

export type RunList = {
  /** Agent runs (run store) and governed tool-call traces (Langfuse + this process's ring), newest first. */
  items: HealthItem[];
  runStore: RunStoreState;
};

export type CollectRunsOptions = {
  /** The viewer's scope, pushed into the run-store read. Absent: every run (callers still `filterScope`). */
  scope?: Scope;
  /** Additive filters. A filtered listing holds agent runs only (traces carry no system or status). */
  filter?: RunListFilter;
  /** Max agent runs read from the store (default 50). */
  limit?: number;
  /** Test seam: the run store. Default: this process's store (Postgres when configured). */
  runSource?: () => Promise<RunListSource>;
  /** Test seam: system display names. Default: the agents registry, best-effort. */
  systemNames?: () => Promise<(systemId: string) => string | undefined>;
};

async function defaultRunSource(): Promise<RunListSource> {
  // Lazy, like every other door into the run store: it is server-only and opens a pool.
  const { runJobStore } = await import('@tabs/agents/lib/build/run-jobs-server');
  return runJobStore();
}

/** System display names for run titles. Best-effort: a miss falls back to the system id. */
async function defaultSystemNames(): Promise<(id: string) => string | undefined> {
  try {
    const agents = await import('@tabs/agents/lib/store');
    await agents.ensureHydrated();
    const names = new Map(agents.listAllSystemsInternal().map((s) => [s.id, s.name]));
    return (id) => names.get(id);
  } catch {
    return () => undefined;
  }
}

/**
 * Collect the runs lens. AGENT RUNS come from the durable run store (the rows the worker writes),
 * scoped in the read, with their real status: a run Langfuse has not ingested is listed all the
 * same. Langfuse and the in-process governed ring still contribute the governed TOOL-CALL traces
 * (and remain the drill-down via `fetchTrace`); an agent-run trace (`run_<uuid>`) from them is not
 * listed a second time, because the store row is the run. An unreachable store is reported in
 * `runStore`, never turned into an empty list.
 */
export async function collectRunList(opts: CollectRunsOptions = {}): Promise<RunList> {
  const filter = opts.filter ?? {};
  const filtered = Boolean(filter.systemId || filter.status);
  const [fromStore, nameOf, traces] = await Promise.all([
    storeRuns(opts.runSource ?? defaultRunSource, { scope: opts.scope, filter, limit: opts.limit ?? 50 }),
    (opts.systemNames ?? defaultSystemNames)(),
    filtered ? Promise.resolve<HealthItem[]>([]) : traceRuns(),
  ]);
  const runs: RunListItem[] = fromStore.ok
    ? fromStore.items.map((it) => {
        const name = it.links?.systemId ? nameOf(it.links.systemId) : undefined;
        return name ? { ...it, title: `${name} — agent run` } : it;
      })
    : [];
  const runStore: RunStoreState = fromStore.ok
    ? { available: true }
    : { available: false, code: 'run_store_unavailable', reason: fromStore.reason };
  const items = [...runs, ...traces.filter((t) => !isRunId(t.id))].sort(
    (a, b) => (Date.parse(b.ts ?? '') || 0) - (Date.parse(a.ts ?? '') || 0),
  );
  // Offline mock: only when nothing live was found, the store answered, nothing was filtered AND
  // demo fixtures are on (dev/test). A real deploy with no runs yet shows an honest empty list.
  if (items.length === 0 && runStore.available && !filtered && config.monitoringDemoFixtures) {
    return { items: [...MOCK_RUNS], runStore };
  }
  return { items, runStore };
}

/**
 * The runs lens as items, for the overview. An unreachable run store becomes ONE `unknown` item
 * owned by the viewer (so the scope filter keeps it), and the lens says it could not list agent
 * runs instead of reading as "no runs".
 */
export async function collectRuns(opts: CollectRunsOptions = {}): Promise<HealthItem[]> {
  const { items, runStore } = await collectRunList(opts);
  if (runStore.available) return items;
  const notice: HealthItem = {
    id: 'run-store-unavailable',
    lens: 'runs',
    title: 'Agent runs could not be listed',
    health: 'unknown',
    detail: `The run store did not answer (${runStore.reason}), so agent runs are not shown here; that does not mean there are none.`,
    owner: opts.scope?.principal ?? 'unknown',
    domain: UNKNOWN_DOMAIN,
    ts: new Date().toISOString(),
    source: 'live',
  };
  return [notice, ...items];
}

/** Governed tool-call traces: this process's ring and Langfuse's newest traces. */
async function traceRuns(): Promise<HealthItem[]> {
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
  return [...lf, ...ring];
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
        domain: traceDomain(meta),
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
        domain: traceDomain(meta),
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
  // Review L3 (2026-11-18): gated EXACTLY like the run LIST at `collectRuns` above, which has
  // always been `config.monitoringDemoFixtures ? [...MOCK_RUNS] : []`. This line was not, so a
  // deployed Monitoring tab answered "open this run" with a fabricated trace — invented node
  // timings and invented logs for a run id that may never have existed. `fetchTrace` already
  // returns `TraceDetail | null`, so the honest answer needs no new shape: null is "no trace",
  // which the caller renders as not-found. `monitoringDemoFixtures` defaults to OFF under
  // NODE_ENV=production (`config.ts`), which is the second switch recorded in the plan.
  return config.monitoringDemoFixtures ? mockTrace(id) : null;
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
 * The domain recorded for a trace that declares none. A SENTINEL, not a guess (review M-1).
 *
 * `domain` is not a label — it is the BUILDER GATE's left-hand side (`canSee`:
 * `scope.domains.includes(it.domain)`). The first version of this fix fell back to
 * {@link principalDomain}, a substring heuristic, so a domain-less run owned by `sales-bot@acme`
 * acquired `domain: 'sales'` and became visible — in the list AND in the drill-in — to every
 * builder and domain admin of a domain whose NAME merely occurred in the principal. That is a
 * read-scope leak, and worse than the empty string it replaced.
 *
 * The parentheses are what make it safe: no OS domain id can contain them, so this value is in no
 * viewer's `scope.domains` and visibility falls back to ownership (`it.owner === scope.principal`),
 * which is the correct answer for a run whose domain nobody recorded. It is also honest to read.
 */
export const UNKNOWN_DOMAIN = '(unknown)';

/**
 * Which domain owns this trace. X-R4: the header showed an EMPTY domain whenever the observer's
 * `metadata.domain` was present but blank (an unassigned system) — `??` only guards `undefined`,
 * so `''` passed straight through. Returns the DECLARED domain, else {@link UNKNOWN_DOMAIN}.
 * It never derives a domain from the principal: see the note above.
 */
export function traceDomain(meta: Record<string, unknown>, _owner?: string): string {
  return String(meta.domain ?? '').trim() || UNKNOWN_DOMAIN;
}

/**
 * Map a principal to its domain. Sales-family principals → 'sales' (worked example).
 *
 * DISPLAY ONLY, and only on the in-process ring, where it predates this stream (review M-1): it
 * is a substring heuristic, so it must never decide the builder gate for a trace whose domain was
 * not recorded. {@link traceDomain} does not call it.
 */
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
