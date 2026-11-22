/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Every model call carries LiteLLM's message-redaction header while masking is on
 * USER STORY: As a platform admin who switched Langfuse masking on, no prompt or completion of ANY
 *             model call (assistant, embeddings, agent module, run path) reaches the gateway's own
 *             Langfuse record, whichever door the call came through.
 * ARCHITECTURE:
 *   - `gatewayRedactionHeaders` is LiteLLM's documented per-request header
 *     (https://docs.litellm.ai/docs/proxy/logging#redact-messages-response-content); its test fails
 *     if the builder returns `{}` for ON.
 *   - Behaviour: each caller is driven against a stand-in `fetch` that records the headers it was given.
 *   - Guard: a scan of the os-ui sources fails when a file calls the gateway's model endpoints, or
 *     builds a `ChatOpenAI`, without going through the shared `gatewayFetch` helper
 *     (`core/adapters/litellm/gateway-fetch.ts`). Its negative twin proves the scanner can fail.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATEWAY_REDACTION_HEADER, gatewayRedactionHeaders } from '@core/runtime/gateway-trace';
import { __setMaskingForTests } from '@core/infra/masking-policy';
import { _reset } from '@tabs/admin/lib/settings';

const realFetch = globalThis.fetch;
let seen: Headers[] = [];
const COMPLETION = JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
const EMBEDDING = (n: number) => JSON.stringify({ object: 'list', data: [{ object: 'embedding', index: 0, embedding: Array.from({ length: n }, () => 0.1) }], model: 'e', usage: { prompt_tokens: 1, total_tokens: 1 } });
beforeEach(() => {
  seen = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    // Only the model endpoints: the settings store (OpenSearch) is read through the same fetch.
    if (/\/v1\/(chat\/completions|embeddings)/.test(url)) seen.push(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)));
    return new Response(/embeddings/.test(url) ? EMBEDDING(Number(process.env.FILES_EMBED_DIM ?? 0) || 1024) : COMPLETION, { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

test('gatewayRedactionHeaders: ON is the documented header, OFF is no header (a builder that returns {} for ON fails here)', () => {
  assert.deepEqual(gatewayRedactionHeaders(true), { 'x-litellm-enable-message-redaction': 'true' });
  assert.equal(GATEWAY_REDACTION_HEADER, 'x-litellm-enable-message-redaction');
  assert.notDeepEqual(gatewayRedactionHeaders(true), {});
  assert.deepEqual(gatewayRedactionHeaders(false), {});
});

const callers: Array<[string, () => Promise<unknown>]> = [
  ['assistant (core/runtime/complete.ts)', async () => { const { liteLlmAssistantCaller } = await import('@core/runtime/complete'); return liteLlmAssistantCaller()({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }); }],
  ['knowledge embeddings', async () => { const { embed } = await import('@tabs/knowledge/lib/embed'); return embed(['hi']); }],
  ['files embeddings', async () => { const { embedTexts } = await import('@tabs/files/lib/embed'); return embedTexts(['hi']); }],
  ['module chat model (chat-model.ts)', async () => { const { gatewayChatModel } = await import('@core/adapters/litellm/chat-model'); const r = gatewayChatModel({ model: 'm', caller: { userId: 'u', domain: 'd' }, writeSystem: false }); assert.ok(r.ok); return r.ok && r.value.invoke('hi'); }],
  ['traced fetch without an observer', async () => { const { tracedModelFetch } = await import('@core/adapters/litellm/traced-fetch'); return tracedModelFetch(null, 'k', 'a')('http://gw/v1/chat/completions', { method: 'POST', body: '{}' }); }],
  ['run path (core/runtime/runtime.ts)', async () => { const { liteLlmCaller } = await import('@core/runtime/runtime'); return liteLlmCaller({ userId: 'u', domain: 'd' })({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] } as never); }],
];

for (const [name, call] of callers) {
  test(`${name}: masking ON sends the redaction header`, async () => {
    __setMaskingForTests({ enabled: true, level: 'pii' });
    await call().catch(() => undefined);
    assert.ok(seen.length > 0, 'the call reached the gateway');
    assert.ok(seen.every((h) => h.get(GATEWAY_REDACTION_HEADER) === 'true'), 'every request carries the header');
  });
  test(`${name}: NEGATIVE TWIN - masking OFF sends no header`, async () => {
    __setMaskingForTests({ enabled: false, level: 'pii' });
    await call().catch(() => undefined);
    assert.ok(seen.length > 0, 'the call reached the gateway');
    assert.ok(seen.every((h) => !h.has(GATEWAY_REDACTION_HEADER)));
  });
}

test('masking UNKNOWN (settings never read, store unreachable): the header is sent - the unknown switch fails safe', async () => {
  _reset();
  const { liteLlmAssistantCaller } = await import('@core/runtime/complete');
  await liteLlmAssistantCaller()({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }).catch(() => undefined);
  assert.ok(seen.length > 0 && seen.every((h) => h.get(GATEWAY_REDACTION_HEADER) === 'true'));
});

// ------------------------------------------------------------------ guard --

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MODEL_CALL = /litellmUrl\}\/v1\/(?:chat\/completions|completions|embeddings)|new ChatOpenAI\(/;
const THROUGH_HELPER = /gatewayFetch|viaGateway\(/;

/** The files that call a model endpoint of the gateway without the shared helper. */
export function bypassing(files: Array<{ path: string; text: string }>): string[] {
  return files.filter((f) => MODEL_CALL.test(f.text) && !THROUGH_HELPER.test(f.text)).map((f) => f.path);
}

function sources(dir: string, out: Array<{ path: string; text: string }> = []): Array<{ path: string; text: string }> {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.next', 'tests', 'scripts', 'coverage'].includes(name) || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !/fixtures\//.test(full)) out.push({ path: relative(ROOT, full), text: readFileSync(full, 'utf8') });
  }
  return out;
}

// Not an OS call path: this file only holds the TEXT of the standalone project an agent is ejected as
// (it runs on its own, outside the OS, with its own OpenAI-compatible endpoint).
const EXEMPT = new Set(['tabs/agents/lib/module/generate.ts']);

test('GUARD: no os-ui source calls a gateway model endpoint (or builds a ChatOpenAI) except through gatewayFetch', () => {
  const all = sources(ROOT);
  assert.ok(all.some((f) => MODEL_CALL.test(f.text)), 'the scanner finds the known callers (it is not scanning nothing)');
  assert.deepEqual(bypassing(all).filter((p) => !EXEMPT.has(p)), []);
});

test('GUARD NEGATIVE TWIN: the scanner flags a caller that bypasses the helper and passes one that uses it', () => {
  const raw = 'await fetch(`${config.litellmUrl}/v1/embeddings`, {})';
  assert.deepEqual(bypassing([{ path: 'x.ts', text: raw }]), ['x.ts']);
  assert.deepEqual(bypassing([{ path: 'x.ts', text: `import { gatewayFetch } from 'y';\nawait gatewayFetch(\`\${config.litellmUrl}/v1/embeddings\`, {})` }]), []);
  assert.deepEqual(bypassing([{ path: 'y.ts', text: 'new ChatOpenAI({})' }]), ['y.ts']);
});
