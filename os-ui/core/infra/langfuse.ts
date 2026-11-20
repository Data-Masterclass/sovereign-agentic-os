/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The ONE Langfuse writer of the OS — OpenTelemetry export through the official
 *             Langfuse JS SDK v5, the run trace, standalone observations, scores, the deep link
 *             and the filtered observation read.
 * USER STORY: As an engineer I open a run's trace in Langfuse and see one trace per run: the run,
 *             its graph nodes, every tool call with its governance decision, and exactly ONE
 *             generation per model call — the gateway's. As a security reviewer I can confirm that
 *             no other file in os-ui sends anything to Langfuse, and that every read is filtered.
 * ARCHITECTURE: (design 05 §5.1, steps 1–3 with Revision 1, 3, 6, 8)
 *   - Export: `NodeSDK` + `LangfuseSpanProcessor` (`@langfuse/otel`), started once per process
 *     (`globalThis` slot; route handlers are bundled separately). In-cluster `baseUrl`, client-side
 *     `osMask` (inline media stripped), and `shouldExportSpan` that keeps Langfuse observations and
 *     DROPS any app-side `generation`: the gateway (LiteLLM) owns the generation of a model call.
 *   - Writing: `@langfuse/tracing` (`startObservation`, `startActiveObservation`,
 *     `propagateAttributes`, `createTraceId`). The run trace id is `createTraceId(runId)`; every run
 *     segment hangs on a FIXED root span id derived from the run id, so a resume in another process
 *     stays under the same root. `userId` is the runner's bare uid, `sessionId` is `system:<id>`.
 *   - Model calls: a `llm.<node>` span whose OTel span id the LiteLLM caller forwards as
 *     `parent_observation_id` (legacy callback) and as `traceparent`; the gateway's generation nests
 *     under it. The span carries the redacted output, never usage, so tokens are counted once.
 *   - Standalone observations (`recordObservation`): a governed data tool, a knowledge context pack
 *     or an agent tool outside a run. Inside an active observation (a run's tool call) it nests
 *     there by OTel context; otherwise it is its own small trace. Never a raw ingestion POST.
 *   - Scores through `@langfuse/client` `score.create`. Reads stay filtered (`observationsQuery`).
 *   - Nothing here throws into a caller: the trace store being down is an expected state.
 */
import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { TraceFlags, type SpanContext } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type { SpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { LangfuseSpanProcessor, isDefaultExportSpan } from '@langfuse/otel';
import { createTraceId, propagateAttributes, startActiveObservation, startObservation, type LangfuseAgent, type LangfuseChain } from '@langfuse/tracing';
import { LangfuseClient } from '@langfuse/client';
import { config } from '@core/kernel/config';
import {
  DEFAULT_REDACTION,
  boundedResult,
  noopObserver,
  redactArgs,
  redactCompletion,
  redactRequest,
  runSessionId,
  runTraceTags,
  type RedactionLevel,
  type RunObserver,
  type RunTraceInput,
  type SpanHandle,
  type ToolDecision,
} from '@core/infra/trace-port';

export type { RunTraceContext } from '@core/infra/trace-port';

// ---------------------------------------------------------------- bootstrap --

type TracingSlot = {
  sdk: NodeSDK | null;
  processor: LangfuseSpanProcessor | null;
  client: LangfuseClient | null;
  /** Tests: export to this exporter instead of the Langfuse OTLP endpoint. */
  exporter?: SpanExporter;
};
const SLOT_KEY = Symbol.for('soa.langfuse.otel');
function slot(): TracingSlot {
  const g = globalThis as unknown as Record<symbol, TracingSlot | undefined>;
  if (!g[SLOT_KEY]) g[SLOT_KEY] = { sdk: null, processor: null, client: null };
  return g[SLOT_KEY]!;
}

/** True when the keys and URL are configured (or a test exporter is installed). */
export function langfuseEnabled(): boolean {
  if (slot().exporter) return true;
  return config.langfuseUrl.length > 0 && config.langfusePublicKey.length > 0 && config.langfuseSecretKey.length > 0;
}

/** The OTel attribute that names a Langfuse observation's type. */
const OBSERVATION_TYPE = 'langfuse.observation.type';

/**
 * Export the Langfuse observations the OS writes, and never an app-side GENERATION: one model call
 * has exactly one generation, written by the gateway. Anything else (foreign instrumentation) is
 * decided by Langfuse's own default filter.
 */
export function exportOsSpan({ otelSpan }: { otelSpan: ReadableSpan }): boolean {
  if (otelSpan.attributes[OBSERVATION_TYPE] === 'generation') return false;
  return isDefaultExportSpan(otelSpan);
}

const DATA_URI = /data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)/g;

/**
 * The client-side mask: inline media (`data:` URIs, e.g. an `image_url` part) is replaced by its
 * type, size and hash before export, so no media leaves the pod. Text redaction (`structure` /
 * `strict`) is applied earlier, where the observation is built (`trace-port.ts`).
 */
export function osMask({ data }: { data: unknown }): unknown {
  if (typeof data !== 'string' || !data.includes('data:')) return data;
  return data.replace(DATA_URI, (_m, mime: string, b64: string) => {
    const bytes = Math.floor((b64.length * 3) / 4);
    const sha256 = createHash('sha256').update(b64).digest('hex').slice(0, 16);
    return `[media ${mime} ${bytes} bytes sha256:${sha256}]`;
  });
}

/**
 * Start the process's tracer once. Returns false when Langfuse is not configured. The SIGTERM hook
 * hands the export buffer over before a pod stops (rolling restart, worker finishing a superstep).
 */
function ensureTracing(): boolean {
  const s = slot();
  if (s.processor) return true;
  if (!langfuseEnabled()) return false;
  try {
    const processor = new LangfuseSpanProcessor({
      ...(s.exporter
        ? { exporter: s.exporter, exportMode: 'immediate' as const }
        : { publicKey: config.langfusePublicKey, secretKey: config.langfuseSecretKey, baseUrl: config.langfuseUrl, timeout: 5 }),
      mask: osMask,
      shouldExportSpan: exportOsSpan,
      mediaUploadEnabled: false,
    });
    // No metrics and no logs: this SDK exists to export Langfuse traces only.
    const sdk = new NodeSDK({ spanProcessors: [processor], metricReaders: [], logRecordProcessors: [], autoDetectResources: false, serviceName: 'os-ui' });
    sdk.start();
    s.processor = processor;
    s.sdk = sdk;
    process.once('SIGTERM', () => void sdk.shutdown().catch(() => undefined));
    return true;
  } catch {
    return false;
  }
}

/** Test seam: export every span to `exporter` (an in-memory exporter) instead of Langfuse. Call before the first trace. */
export function __useSpanExporterForTests(exporter: SpanExporter): void {
  slot().exporter = exporter;
}

/** Flush the export buffer (and pending scores). Never throws. */
export async function flushLangfuse(): Promise<void> {
  const s = slot();
  try {
    await Promise.all([s.processor?.forceFlush(), s.client?.flush()]);
  } catch {
    /* the trace store being down is an expected state */
  }
}

// ------------------------------------------------------------------ run ids --

/** The Langfuse trace id of a run: `createTraceId(runId)` (32-hex, deterministic). */
export function langfuseTraceId(runId: string): Promise<string> {
  return createTraceId(runId);
}

/** The fixed span id every segment of a run hangs on, so resumes stay under one root. */
async function runRootSpanId(runId: string): Promise<string> {
  return (await createTraceId(`root:${runId}`)).slice(0, 16);
}

/** Does Langfuse hold a trace with this id? Unreachable or slow counts as "no" (bounded wait). */
async function traceExists(traceId: string, timeoutMs = 1_500): Promise<boolean> {
  const auth = 'Basic ' + Buffer.from(`${config.langfusePublicKey}:${config.langfuseSecretKey}`).toString('base64');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.langfuseUrl}/api/public/traces/${encodeURIComponent(traceId)}`, { headers: { authorization: auth, accept: 'application/json' }, cache: 'no-store', signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The deep link to ONE run's trace: `<console>/trace/<createTraceId(runId)>`, which Langfuse
 * redirects into the owning project. A run traced BEFORE the OTel writer (20 Nov 2026) has its raw
 * run id as trace id: when the mapped id is not in Langfuse and the raw id is, the link uses the
 * raw id, so an old run opens its own trace instead of Langfuse's not-found page. `probe: false`
 * skips the lookup for a run this process has just traced (always the mapped id). Undefined when
 * no console URL is configured.
 */
export async function traceUrlFor(runId: string, opts: { probe?: boolean } = {}): Promise<string | undefined> {
  const base = config.langfuseConsoleUrl;
  if (!base || !runId) return undefined;
  const mapped = await langfuseTraceId(runId);
  if (opts.probe !== false && langfuseEnabled() && !(await traceExists(mapped)) && (await traceExists(runId))) {
    return `${base}/trace/${encodeURIComponent(runId)}`;
  }
  return `${base}/trace/${mapped}`;
}

// ---------------------------------------------------------------- run trace --

const TASK_MAX = 500;
const safe = (fn: () => void): void => {
  try {
    fn();
  } catch {
    /* observability never fails a run */
  }
};
const message = (e: unknown): string => ((e as Error)?.message ?? String(e)).slice(0, 300);

/** A policy refusal is `denied`; any other error result is `error`. */
function decisionOf(out: { text: string; isError: boolean }, given: ToolDecision): ToolDecision {
  if (!out.isError) return given;
  return /"code":"(forbidden|denied|held|rejected|withdrawn_by_requester)"/.test(out.text) ? 'denied' : 'error';
}

/**
 * Run `fn` with the run segment's observer. One trace per run (`createTraceId(runId)`); a fresh
 * start opens `run <system>`, a resume opens `run segment`, both under the run's fixed root id.
 * `userId`, `sessionId`, tags, version and trace name are propagated to every observation the
 * segment writes. With Langfuse unconfigured `fn` gets the no-op observer.
 */
export async function withRunTrace<T>(input: RunTraceInput, fn: (observer: RunObserver) => Promise<T>): Promise<T> {
  if (!ensureTracing()) return fn(noopObserver(input.runId));
  const traceId = await langfuseTraceId(input.runId);
  const rootSpanId = await runRootSpanId(input.runId);
  const level: RedactionLevel = input.redaction ?? DEFAULT_REDACTION;
  const environment = input.environment;
  const env = environment ? { environment } : {};
  const root: SpanContext = { traceId, spanId: rootSpanId, traceFlags: TraceFlags.SAMPLED, isRemote: true };

  return propagateAttributes(
    {
      userId: input.userId,
      sessionId: runSessionId(input.systemId),
      tags: runTraceTags(input),
      traceName: `run ${input.systemName}`,
      ...(input.version ? { version: input.version } : {}),
      metadata: {
        runId: input.runId,
        systemId: input.systemId,
        domain: input.domain,
        engine: input.engine ?? 'langgraph',
        ...(input.principal ? { principal: input.principal } : {}),
      },
    },
    () => {
      let segment: LangfuseAgent | null = null;
      safe(() => {
        segment = startObservation(
          input.resume ? 'run segment' : `run ${input.systemName}`,
          {
            ...env,
            input: input.task ? { task: input.task.length > TASK_MAX ? `${input.task.slice(0, TASK_MAX)}…` : input.task } : undefined,
            metadata: { resume: !!input.resume },
          },
          { asType: 'agent', parentSpanContext: root },
        );
      });
      const segmentCtx = (): SpanContext => (segment as LangfuseAgent | null)?.otelSpan.spanContext() ?? root;

      const makeSpan = (name: string, metadata?: Record<string, unknown>): SpanHandle => {
        let node: LangfuseChain | null = null;
        safe(() => { node = startObservation(name, { ...env, metadata }, { asType: 'chain', parentSpanContext: segmentCtx() }); });
        const nodeCtx = (): SpanContext => (node as LangfuseChain | null)?.otelSpan.spanContext() ?? segmentCtx();
        return {
          id: (node as LangfuseChain | null)?.id ?? rootSpanId,
          traceId,
          // ONE span per model call. The gateway (LiteLLM OTel v2) nests its generation under it by
          // the W3C `traceparent` built from this span's ids, so the gateway's generation is the
          // call's only generation. The call id (`x-litellm-call-id`) is minted here and recorded
          // as `litellm_call_id`: the gateway reports the same id as `litellm.call_id` (10 F1).
          llm: (inner, spanName) => (req) =>
            startActiveObservation(
              spanName ?? `llm.${name}`,
              async (span) => {
                const callId = randomUUID();
                safe(() => span.update({ input: redactRequest(req, level), metadata: { kind: 'model-call', model: req.model, tools: (req.tools ?? []).length, node: metadata?.agent, litellm_call_id: callId } }));
                try {
                  // `node` (the agent) rides to the gateway's generation as metadata, so
                  // per-agent tokens and cost are read straight off the generation.
                  const node = typeof metadata?.agent === 'string' ? metadata.agent : name;
                  const completion = await inner({ ...req, observe: { traceId, parentObservationId: span.id, node, callId } });
                  safe(() => span.update({ output: redactCompletion(completion, level) }));
                  return completion;
                } catch (e) {
                  safe(() => span.update({ level: 'ERROR', statusMessage: message(e) }));
                  throw e;
                }
              },
              { asType: 'span', parentSpanContext: nodeCtx() },
            ),
          // The tool observation is ACTIVE while the call runs, so whatever the governed call
          // records (a retrieval, a data tool) nests under it by OTel context.
          tool: (call, meta, run) =>
            startActiveObservation(
              `tool.${call.name}`,
              async (tool) => {
                safe(() => tool.update({ ...env, input: { tool: call.name, callId: call.id, args: redactArgs(call.args, level) }, metadata: { decision: meta.decision, approvalId: meta.approvalId, redaction: level } }));
                try {
                  const out = await run();
                  safe(() => tool.update({ output: { isError: out.isError, ...boundedResult(out.text, level) }, level: out.isError ? 'WARNING' : 'DEFAULT', metadata: { decision: decisionOf(out, meta.decision), approvalId: meta.approvalId } }));
                  return out;
                } catch (e) {
                  safe(() => tool.update({ level: 'ERROR', statusMessage: message(e), metadata: { decision: 'error', approvalId: meta.approvalId } }));
                  throw e;
                }
              },
              { asType: 'tool', parentSpanContext: nodeCtx() },
            ),
          toolEvent: (call, meta) =>
            safe(() => {
              startObservation(
                `tool.${call.name}`,
                {
                  ...env,
                  input: { tool: call.name, callId: call.id, args: redactArgs(call.args, level) },
                  output: meta.detail ? { detail: meta.detail } : undefined,
                  level: meta.decision === 'held' ? 'DEFAULT' : 'WARNING',
                  metadata: { decision: meta.decision, approvalId: meta.approvalId },
                },
                { asType: 'event', parentSpanContext: nodeCtx() },
              );
            }),
          end: (status) =>
            safe(() => {
              (node as LangfuseChain | null)?.update({
                output: status?.output,
                level: status?.error ? 'ERROR' : 'DEFAULT',
                statusMessage: status?.error ? status.error.slice(0, 300) : status?.parked ? 'parked on approval' : undefined,
                metadata: { ...(metadata ?? {}), ...(status?.metadata ?? {}), ...(status?.parked ? { parked: true } : {}) },
              }).end();
            }),
        };
      };

      const observer: RunObserver = {
        traceId,
        enabled: true,
        span: makeSpan,
        finish: (outcome) =>
          safe(() => {
            startObservation('run.result', { ...env, output: outcome, level: outcome.failed ? 'ERROR' : 'DEFAULT' }, { asType: 'event', parentSpanContext: segmentCtx() });
            (segment as LangfuseAgent | null)?.update({ output: outcome, level: outcome.failed ? 'ERROR' : 'DEFAULT' }).end();
          }),
        flush: flushLangfuse,
      };
      return fn(observer);
    },
  );
}

// ---------------------------------------------------- standalone observations --

export type StandaloneObservation = {
  name: string;
  asType: 'tool' | 'retriever' | 'span' | 'event';
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  level?: 'DEFAULT' | 'WARNING' | 'ERROR';
  tags?: string[];
};

/**
 * Record one observation that is not part of a run's own tree: a governed data tool, a knowledge
 * context pack, an agent tool called outside a run. Inside an active observation it nests there;
 * otherwise it is its own trace. Returns whether it was handed to the exporter.
 */
export function recordObservation(o: StandaloneObservation): boolean {
  if (!ensureTracing()) return false;
  try {
    const attrs = { input: o.input, output: o.output, metadata: o.metadata, level: o.level };
    const write = (): void => {
      // An event ends on creation; the others are point-in-time records, ended at once.
      if (o.asType === 'event') startObservation(o.name, attrs, { asType: 'event' });
      else if (o.asType === 'tool') startObservation(o.name, attrs, { asType: 'tool' }).end();
      else if (o.asType === 'retriever') startObservation(o.name, attrs, { asType: 'retriever' }).end();
      else startObservation(o.name, attrs).end();
    };
    if (o.tags && o.tags.length > 0) propagateAttributes({ tags: o.tags }, write);
    else write();
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------- scores --

function scoreClient(): LangfuseClient | null {
  const s = slot();
  if (!langfuseEnabled() || s.exporter) return null;
  if (!s.client) s.client = new LangfuseClient({ publicKey: config.langfusePublicKey, secretKey: config.langfuseSecretKey, baseUrl: config.langfuseUrl });
  return s.client;
}

/** Write a numeric score onto a run's trace (e.g. the LLM-judge verdict). Buffered; never throws. */
export async function scoreTrace(input: { runId: string; name: string; value: number; comment?: string; metadata?: Record<string, unknown> }): Promise<boolean> {
  const c = scoreClient();
  if (!c) return false;
  try {
    // Queued; the client sends within its flush interval (1 s) or on `flushLangfuse()`.
    c.score.create({ traceId: await langfuseTraceId(input.runId), name: input.name, value: input.value, comment: input.comment, metadata: input.metadata });
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
  /** 1-based page of the result (Langfuse public API `page`). */
  page?: number;
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
  if (f.page && f.page > 1) q.set('page', String(Math.floor(f.page)));
  return q.toString();
}

/** One observation row as the public API returns it (the subset the OS reads). */
export type LangfuseObservationRow = {
  id?: string;
  traceId?: string;
  type?: string;
  name?: string;
  parentObservationId?: string | null;
  model?: string;
  startTime?: string;
  endTime?: string;
  usage?: { input?: number; output?: number; total?: number };
  calculatedTotalCost?: number;
  metadata?: Record<string, unknown>;
};

/**
 * Every observation of ONE run's trace, so a reader can relate the gateway's generation to the OS's
 * `llm.<node>` span that made the call (LiteLLM OTel v2, 10 F1). Pages through the same filtered
 * read (`traceId`, 100 per page, at most 20 pages). Null when the store cannot be reached.
 */
export async function readTraceObservations(traceId: string): Promise<LangfuseObservationRow[] | null> {
  const all: LangfuseObservationRow[] = [];
  for (let page = 1; page <= 20; page++) {
    const rows = await readObservations({ traceId, limit: 100, page });
    if (rows === null) return null;
    all.push(...rows);
    if (rows.length < 100) break;
  }
  return all;
}

/**
 * Read observations through the public API — filtered, always. Returns null when the store cannot
 * be reached (an expected state), throws `UnfilteredLangfuseQueryError` for a leaking filter.
 */
export async function readObservations(filter: ObservationFilter, timeoutMs = 3_000): Promise<LangfuseObservationRow[] | null> {
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
    const body = (await res.json().catch(() => null)) as { data?: LangfuseObservationRow[] } | null;
    return Array.isArray(body?.data) ? body!.data : [];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
