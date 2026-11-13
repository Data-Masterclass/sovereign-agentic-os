/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The ONE Langfuse client of the OS — buffered ingestion through the official JS SDK,
 *             the run-trace deep link, scores, and the filtered observation read.
 * USER STORY: As an engineer I open a run's trace in Langfuse and see one trace whose id IS the run
 *             id, with nodes, model calls and tool calls nested under it. As a security reviewer I
 *             can confirm that every Langfuse READ the OS performs is filtered by run, user or scope,
 *             so no surface ever lists another user's observations.
 * ARCHITECTURE:
 *   - Wraps `langfuse` (the official SDK, 3.x, MIT) as a process singleton pinned to `globalThis`
 *     (route handlers are bundled separately). Events are buffered by the SDK and flushed in the
 *     background; nothing here blocks a run. `enabled` is false when no keys are configured.
 *   - Observability plumbing lives in `core/infra` because both the kernel (`agent-governed.ts`
 *     `trace()`) and the Agents tab (`tabs/agents/lib/engine/observe.ts`) need it; the kernel never
 *     imports a tab.
 *   - `observationsQuery` is PURE and refuses an unfiltered query (typed error) — the rule the
 *     diagnostics route and its test pin down (checklist A23). `traceUrlFor` builds the SDK's own
 *     `/trace/<id>` deep link (Langfuse redirects it into the project).
 *   - Tests inject a client subclass whose `fetch` records the ingestion batches
 *     (`__setLangfuseClientForTests`); production constructs one from `config`.
 */
import 'server-only';
import { Langfuse } from 'langfuse';
import { config } from '@core/kernel/config';

/** Where an observation hangs: the run trace (id = run id) and, optionally, the span it nests under. */
export type RunTraceContext = { traceId: string; parentObservationId?: string };

const CLIENT_KEY = Symbol.for('soa.langfuse.client');
type ClientSlot = { client: Langfuse | null; override: Langfuse | null | undefined };
function slot(): ClientSlot {
  const g = globalThis as unknown as Record<symbol, ClientSlot | undefined>;
  if (!g[CLIENT_KEY]) g[CLIENT_KEY] = { client: null, override: undefined };
  return g[CLIENT_KEY]!;
}

/** True when ingestion keys are configured; false means every trace call is a no-op. */
export function langfuseEnabled(): boolean {
  const s = slot();
  if (s.override !== undefined) return s.override !== null;
  return config.langfuseUrl.length > 0 && config.langfusePublicKey.length > 0 && config.langfuseSecretKey.length > 0;
}

/**
 * The shared SDK client, or null when Langfuse is not configured. Buffered: `flushAt` events or
 * `flushInterval` ms, whichever first; one retry; a short request timeout — the trace store being
 * down is an expected state, never a reason to slow a run.
 */
export function langfuseClient(): Langfuse | null {
  const s = slot();
  if (s.override !== undefined) return s.override;
  if (!langfuseEnabled()) return null;
  if (!s.client) {
    s.client = new Langfuse({
      publicKey: config.langfusePublicKey,
      secretKey: config.langfuseSecretKey,
      baseUrl: config.langfuseUrl,
      flushAt: 20,
      flushInterval: 2_000,
      requestTimeout: 5_000,
      fetchRetryCount: 1,
      sdkIntegration: 'sovereign-os',
    });
    // An unreachable trace store must not spam the pod log on every batch: the ring in
    // `agent-governed.ts` keeps Monitoring legible without Langfuse.
    s.client.on('error', () => undefined);
    // A3 review: the SDK buffers (flushAt 20 / flushInterval 2s), so a pod that is told to stop —
    // a rolling restart, or the agent-run worker finishing its superstep — must hand the buffer
    // over before it exits, or the last spans of the last run are lost. `shutdownAsync` flushes
    // and stops the timer; `once` so repeated construction cannot stack listeners.
    const client = s.client;
    process.once('SIGTERM', () => void client.shutdownAsync().catch(() => undefined));
  }
  return s.client;
}

/** Test seam: inject a recording client (or `null` = disabled); `undefined` restores production. */
export function __setLangfuseClientForTests(client: Langfuse | null | undefined): void {
  slot().override = client;
}

/** Flush the buffer in the background. Never throws, never awaited by a run. */
export function flushLangfuse(): Promise<void> {
  const c = langfuseClient();
  if (!c) return Promise.resolve();
  return c.flushAsync().catch(() => undefined);
}

/**
 * The deep link to ONE run's trace: `<console>/trace/<runId>` — the SDK's own `getTraceUrl` shape,
 * which Langfuse redirects into the owning project. Empty when no console URL is configured
 * (the chart sets an explicit empty value when the console is not exposed).
 */
export function traceUrlFor(runId: string): string | undefined {
  const base = config.langfuseConsoleUrl;
  if (!base || !runId) return undefined;
  return `${base}/trace/${encodeURIComponent(runId)}`;
}

/** Write a numeric score onto a run trace (e.g. the LLM-judge verdict). Buffered; never throws. */
export function scoreTrace(input: { traceId: string; name: string; value: number; comment?: string; metadata?: Record<string, unknown> }): boolean {
  const c = langfuseClient();
  if (!c) return false;
  try {
    c.score({ traceId: input.traceId, name: input.name, value: input.value, comment: input.comment, metadata: input.metadata });
    void flushLangfuse();
    return true;
  } catch {
    return false;
  }
}

// ----------------------------------------------------------- filtered reads --

export type ObservationFilter = {
  /** The run's trace id — the ONLY filter a run-scoped read should ever need. */
  traceId?: string;
  /** Without a trace id, BOTH `userId` and `fromTimestamp` are required. */
  userId?: string;
  fromTimestamp?: string;
  type?: 'GENERATION' | 'SPAN' | 'EVENT';
  limit?: number;
};

/** Thrown for a Langfuse read that would return observations not scoped to a run or a user. */
export class UnfilteredLangfuseQueryError extends Error {
  readonly code = 'unfiltered_langfuse_query';
  constructor() {
    super('Refusing an unfiltered Langfuse read: pass a traceId, or both userId and fromTimestamp');
    this.name = 'UnfilteredLangfuseQueryError';
  }
}

/**
 * The query string for `/api/public/observations`, or a typed error when the filter would leak.
 * Pure, so the rule is testable without a network.
 */
export function observationsQuery(f: ObservationFilter): string {
  const traceId = (f.traceId ?? '').trim();
  const userId = (f.userId ?? '').trim();
  const from = (f.fromTimestamp ?? '').trim();
  if (!traceId && !(userId && from)) throw new UnfilteredLangfuseQueryError();
  const q = new URLSearchParams();
  if (traceId) q.set('traceId', traceId);
  else {
    q.set('userId', userId);
    q.set('fromTimestamp', from);
  }
  if (f.type) q.set('type', f.type);
  q.set('limit', String(Math.min(Math.max(f.limit ?? 100, 1), 100)));
  return q.toString();
}

/** One observation row as the public API returns it (the subset the OS reads). */
export type LangfuseObservation = {
  id?: string;
  traceId?: string;
  type?: string;
  name?: string;
  model?: string;
  startTime?: string;
  endTime?: string;
  usage?: { input?: number; output?: number; total?: number };
  calculatedTotalCost?: number;
  metadata?: Record<string, unknown>;
};

/**
 * Read observations through the public API — filtered, always. Returns null when the store cannot
 * be reached (an expected state), throws `UnfilteredLangfuseQueryError` for a leaking filter.
 */
export async function readObservations(filter: ObservationFilter, timeoutMs = 3_000): Promise<LangfuseObservation[] | null> {
  const query = observationsQuery(filter);
  if (!langfuseEnabled()) return null;
  const auth = 'Basic ' + Buffer.from(`${config.langfusePublicKey}:${config.langfuseSecretKey}`).toString('base64');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.langfuseUrl}/api/public/observations?${query}`, {
      headers: { authorization: auth, accept: 'application/json' },
      cache: 'no-store',
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { data?: LangfuseObservation[] } | null;
    return Array.isArray(body?.data) ? body!.data : [];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
