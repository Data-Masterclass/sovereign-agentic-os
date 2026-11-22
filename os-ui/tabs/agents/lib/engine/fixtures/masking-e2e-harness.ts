/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Shared rig of the Langfuse masking e2e tests (`masking.e2e.test.ts`,
 *             `masking-gateway.e2e.test.ts`)
 * ARCHITECTURE: test-only. It starts (1) the scripted OpenAI-compatible model the stack's LiteLLM
 *             routes to and (2) a RECORDING FORWARDER in front of the real Langfuse web
 *             container: every request os-ui sends to Langfuse is stored (gunzipped) and
 *             forwarded unchanged, so a test can search the exact ingestion payload for a seeded
 *             value. Reads of the stored trace go straight to Langfuse's public API.
 *             The caller sets LANGFUSE_URL / LITELLM_URL (to the forwarder and the gateway)
 *             BEFORE the first call here: `config` reads them at import.
 */
import { createServer, request as httpRequest, type Server } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import type { LlmCall } from '@core/runtime/agentic';

export const LANGFUSE = process.env.LANGFUSE_E2E_URL ?? `http://127.0.0.1:${process.env.LANGFUSE_E2E_PORT ?? '13031'}`;
export const PK = 'pk-lf-e2e-public';
export const SK = 'sk-lf-e2e-secret';
export const AUTH = 'Basic ' + Buffer.from(`${PK}:${SK}`).toString('base64');
export const STUB_PORT = Number(process.env.STUB_MODEL_PORT ?? '18931');

/** The values the tests seed into a run. None of them is a secret; they are shaped like personal data. */
export const SEED = {
  email: 'maria.keller@example-customer.de',
  iban: 'DE89370400440532013000',
  phone: '+49 170 1234567',
  phrase: 'Refund the invoice for the Keller account',
} as const;
export const SEEDED_TASK = `${SEED.phrase}. Contact ${SEED.email}, IBAN ${SEED.iban}, phone ${SEED.phone}.`;

export type Recording = { url: string; method: string; body: string };

/** A forwarder that records what os-ui sends to Langfuse and relays it to the real container. */
export function startRecordingForwarder(): Promise<{ server: Server; url: string; recorded: Recording[] }> {
  const recorded: Recording[] = [];
  const target = new URL(LANGFUSE);
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      let text: string;
      try {
        text = req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw).toString('latin1') : raw.toString('latin1');
      } catch {
        text = raw.toString('latin1');
      }
      if (req.method === 'POST') recorded.push({ url: req.url ?? '', method: req.method, body: text });
      const out = httpRequest({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers }, (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      });
      out.on('error', () => { res.writeHead(502); res.end(); });
      out.end(raw);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    server.unref();
    const port = (server.address() as { port: number }).port;
    resolve({ server, url: `http://127.0.0.1:${port}`, recorded });
  }));
}

/** The scripted model of the parity harness, served as an OpenAI-compatible endpoint for LiteLLM. */
export async function startStubModel(script: LlmCall): Promise<{ server: Server; calls: () => number }> {
  let calls = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      try {
        const body = JSON.parse(raw || '{}') as { model: string; messages: never[]; tools?: never[] };
        calls += 1;
        const out = await script({ model: body.model, messages: body.messages, tools: body.tools });
        const toolCalls = (out.toolCalls ?? []).map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args ?? {}) } }));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: `chatcmpl-${randomUUID()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'stub-model',
          choices: [{ index: 0, finish_reason: toolCalls.length ? 'tool_calls' : 'stop', message: { role: 'assistant', content: out.content ?? '', ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }));
      } catch (e) {
        res.writeHead(500);
        res.end(String(e));
      }
    });
  });
  return new Promise((resolve) => server.listen(STUB_PORT, '0.0.0.0', () => resolve({ server, calls: () => calls })));
}

export type Observation = { id: string; type: string; name: string; parentObservationId: string | null; endTime?: string | null; input?: unknown; output?: unknown; usage?: { total?: number }; calculatedTotalCost?: number; latency?: number; model?: string | null; metadata?: Record<string, unknown> };
export type Trace = { id: string; userId: string | null; sessionId: string | null; tags: string[]; input?: unknown; output?: unknown; observations: Observation[] };

async function readTrace(traceId: string): Promise<Trace | null> {
  const res = await fetch(`${LANGFUSE}/api/public/traces/${traceId}`, { headers: { authorization: AUTH } });
  return res.ok ? ((await res.json()) as Trace) : null;
}

/** Poll Langfuse's own API until the whole run trace is stored (ingestion is asynchronous). */
export async function settledTrace(traceId: string, generations: number, timeoutMs = 120_000): Promise<Trace> {
  const deadline = Date.now() + timeoutMs;
  let missing = 'the trace';
  while (Date.now() < deadline) {
    const t = await readTrace(traceId);
    if (!t) missing = 'the trace';
    else if (!t.userId || !t.sessionId) missing = 'userId/sessionId';
    else if (!t.observations.some((o) => o.name === 'run.result')) missing = 'run.result';
    else if (t.observations.filter((o) => o.type === 'GENERATION').length < generations) missing = 'generations';
    else if (t.observations.filter((o) => o.type === 'GENERATION').some((g) => !g.usage?.total)) missing = 'generation usage';
    else if (t.observations.some((o) => o.type !== 'EVENT' && !o.endTime)) missing = 'unfinished observations';
    else return t;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`trace ${traceId} incomplete after ${timeoutMs} ms: missing ${missing}`);
}

/** What a test hands over to drive one real run (its own imports, so this file reaches no admin module). */
export type RunKit = {
  parseSystem: (yaml: string) => { system: { name: string; domain: string } };
  compile: (sys: never) => unknown;
  runGraphEngine: (args: never) => Promise<{ reachedEnd: boolean }>;
  memoryCheckpointer: () => unknown;
  shapeYaml: string;
  graphDeps: (sys: never, systemId: string, llm: LlmCall, sink: { enqueued: string[] }) => object;
  liteLlmCaller: (ctx: { userId: string; domain: string; systemId: string; tab: string; runId: string; env: string }) => LlmCall;
};

/** One real agent run (real engine, real model caller, real gateway) with the seeded task. */
export async function tracedRun(runId: string, kit: RunKit): Promise<{ result: { reachedEnd: boolean }; traceId: string }> {
  const { withRunTrace, flushLangfuse, langfuseTraceId } = await import('@core/infra/langfuse');
  const sys = kit.parseSystem(kit.shapeYaml);
  const gateway = kit.liteLlmCaller({ userId: 'rae', domain: sys.system.domain, systemId: 'sys-e2e-mask', tab: 'agents', runId, env: 'test' });
  const result = await withRunTrace(
    { runId, systemId: 'sys-e2e-mask', systemName: sys.system.name, userId: 'rae', domain: sys.system.domain, task: SEEDED_TASK, environment: 'test', principal: 'os-sys-e2e-mask' },
    (observe) => kit.runGraphEngine({
      ir: kit.compile(sys as never),
      deps: { ...kit.graphDeps(sys as never, 'sys-e2e-mask', gateway, { enqueued: [] }), observe },
      messages: [{ role: 'user', content: SEEDED_TASK }],
      runId,
      checkpointer: kit.memoryCheckpointer(),
    } as never),
  );
  await flushLangfuse();
  return { result, traceId: await langfuseTraceId(runId) };
}

/** True when `needle` is in the text, as written or as a JSON-escaped string. */
export function contains(haystack: string, needle: string): boolean {
  return haystack.includes(needle) || haystack.includes(JSON.stringify(needle).slice(1, -1));
}
