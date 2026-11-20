/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        admin
 * FEATURE:    Provider-agnostic LLM setup, proven on the REAL LiteLLM image behind the REAL egress proxy
 * USER STORY: As a platform admin on Azure, on my own Ollama, or behind any OpenAI-compatible server, I
 *             connect the provider, test it, pick the model and give it to a role — and the OS's own
 *             agent key can call it at once, it survives a gateway restart, a wrong key is a clear
 *             sentence, and a host outside the egress allowlist never leaves the cluster.
 * ARCHITECTURE:
 *   - Runs ONLY against containers started by scripts/tests/llm-providers/run.sh: the chart's LiteLLM
 *     image (pinned digest) with the chart-rendered `litellm-egress-env` (HTTP(S)_PROXY, NO_PROXY), and
 *     the chart's tinyproxy with the chart-rendered filter. The providers are three stubs that speak
 *     the wire protocol of OpenAI-compatible servers, Azure OpenAI (deployment path + api-version +
 *     `api-key` header) and Ollama (`/api/chat`). Without the variables the suite SKIPS, saying so;
 *     with LLM_PROVIDERS_E2E_REQUIRED=1 a missing variable is a FAILURE.
 *   - The flow under test is the OS's own (`connectProvider` → `testProviderConnection` →
 *     `registerProviderModel`), with its default IO: the one admin door `litellm-write.ts`.
 *   - Phase 1 connects and registers; run.sh then RESTARTS the gateway and runs phase 2, which only
 *     calls. Phase 2 passing is the "nothing is lost on restart" proof.
 *   - NEGATIVE TWINS: a wrong key; a host off the allowlist (blocked by the proxy, the stub never sees
 *     the request, and the OS refuses it before storing anything); a key WITHOUT the access group (403,
 *     so the group is what grants the model); an HTTPS provider whose certificate is not trusted (the
 *     TLS handshake fails, the stub never sees a request); an allowlisted name whose DNS answer is a
 *     private address (refused before anything is stored).
 *   - HTTPS: one provider is served over TLS on 443, reached through the proxy's CONNECT tunnel, with
 *     its test CA trusted by the gateway (SSL_CERT_FILE — real providers use public CAs).
 *   - DNS: in the cluster os-ui resolves provider names with the same DNS as the gateway. Here the
 *     "internet" is a private Docker network the test process cannot resolve, so the OS check gets a
 *     stated resolver (LLM_E2E_DNS, public TEST-NET addresses); the traffic itself is real.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const GW = (process.env.LITELLM_URL ?? '').replace(/\/+$/, '');
const AGENT_KEY = process.env.LLM_E2E_AGENT_KEY ?? '';
const NO_GROUP_KEY = process.env.LLM_E2E_NO_GROUP_KEY ?? '';
const STUBS = process.env.LLM_E2E_STUB_DIR ?? '';
const PHASE = process.env.LLM_E2E_PHASE ?? '1';
const REQUIRED = process.env.LLM_PROVIDERS_E2E_REQUIRED === '1';
const missing = [['LITELLM_URL', GW], ['LLM_E2E_AGENT_KEY', AGENT_KEY], ['LLM_E2E_STUB_DIR', STUBS]].filter(([, v]) => !v).map(([k]) => k);
if (REQUIRED && missing.length) throw new Error(`LLM_PROVIDERS_E2E_REQUIRED=1 but unset: ${missing.join(', ')}`);
const skip = missing.length ? `unset: ${missing.join(', ')} (run scripts/tests/llm-providers/run.sh)` : false;

/** Hosts as the harness names them. External ones resolve only on the proxy's network. */
const H = {
  openai: process.env.LLM_E2E_OPENAI_HOST ?? 'openai-stub.example.test',
  azure: process.env.LLM_E2E_AZURE_HOST ?? 'azure-stub.example.test',
  ollama: process.env.LLM_E2E_OLLAMA_HOST ?? 'ollama',          // in-cluster: NO_PROXY
  blocked: process.env.LLM_E2E_BLOCKED_HOST ?? 'blocked-stub.example.test',
  tls: process.env.LLM_E2E_TLS_HOST ?? 'tls-stub.example.test',
  untrusted: process.env.LLM_E2E_UNTRUSTED_HOST ?? 'untrusted-stub.example.test',
};
/** The stated resolver for the OS check (see ARCHITECTURE). */
const DNS: Record<string, string[]> = JSON.parse(process.env.LLM_E2E_DNS ?? '{}');
const resolve = async (host: string) => {
  const a = DNS[host];
  if (!a) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  return a.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};
const RIGHT_KEY = 'sk-stub-right';

const lib = skip ? null : await import('@tabs/admin/lib/llm-providers');
const io = lib ? { ...lib.defaultIo, resolve } : undefined;

function stubLog(name: string): Record<string, unknown>[] {
  const f = `${STUBS}/${name}.jsonl`;
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}
async function chat(key: string, model: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${GW}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hello' }] }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const content = (b: Record<string, unknown>) => ((b.choices as { message: { content: string } }[] | undefined)?.[0]?.message?.content ?? '');

const CASES = [
  { preset: 'openai-compatible', connection: 'e2e-openai', alias: 'e2e-openai-model', model: 'stub-model-1',
    input: { apiBase: `http://${H.openai}/v1`, apiKey: RIGHT_KEY }, stub: 'openai', expectPath: '/v1/chat/completions', answer: 'STUB-openai answered as stub-model-1' },
  { preset: 'azure', connection: 'e2e-azure', alias: 'e2e-azure-model', model: 'os-gpt-deploy',
    input: { apiBase: `http://${H.azure}`, apiVersion: '2024-10-21', apiKey: RIGHT_KEY }, stub: 'azure', expectPath: '/openai/deployments/os-gpt-deploy/chat/completions', answer: 'STUB-azure answered as os-gpt-deploy' },
  { preset: 'openai-compatible', connection: 'e2e-tls', alias: 'e2e-tls-model', model: 'tls-model',
    input: { apiBase: `https://${H.tls}/v1`, apiKey: RIGHT_KEY }, stub: 'tls', expectPath: '/v1/chat/completions', answer: 'STUB-openai answered as tls-model' },
  { preset: 'ollama', connection: 'e2e-ollama', alias: 'e2e-ollama-model', model: 'llama3.2:1b',
    input: { apiBase: `http://${H.ollama}` }, stub: 'ollama', expectPath: '/api/chat', answer: 'STUB-ollama answered as llama3.2:1b' },
] as const;

if (PHASE === '1') {
  for (const c of CASES) {
    test(`${c.preset}: connect → test → register → the shared agent key calls it on the provider's own protocol`, { skip }, async () => {
      const conn = await lib!.connectProvider({ preset: c.preset, name: c.connection, ...c.input }, io);
      assert.equal(conn.ok, true, JSON.stringify(conn));
      const probe = await lib!.testProviderConnection({ preset: c.preset, connection: c.connection, model: c.model, mode: 'chat' });
      assert.equal(probe.ok, true, JSON.stringify(probe));
      const reg = await lib!.registerProviderModel({ preset: c.preset, connection: c.connection, model: c.model, alias: c.alias, mode: 'chat' });
      assert.equal(reg.ok, true, JSON.stringify(reg));
      const r = await chat(AGENT_KEY, c.alias);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(content(r.body), c.answer);
      const hops = stubLog(c.stub).filter((l) => l.path === c.expectPath);
      assert.ok(hops.length >= 2, `the ${c.stub} stub saw the test call and the chat on ${c.expectPath}: ${JSON.stringify(stubLog(c.stub))}`);
      if (c.preset === 'azure') assert.ok(hops.every((h) => h.query === '?api-version=2024-10-21' && h.auth_ok === true), 'Azure: api-version + api-key header');
      if (c.preset === 'openai-compatible') assert.ok(hops.every((h) => h.auth_ok === true), 'OpenAI-compatible: bearer key');
    });
  }

  test('the stored key is LiteLLM\'s, masked when read back — the OS never holds or returns it', { skip }, async () => {
    const list = await lib!.listConnections();
    assert.equal(list.ok, true);
    const azure = list.ok ? list.connections.find((x) => x.name === 'e2e-azure') : undefined;
    assert.equal(azure?.provider, 'azure');
    assert.equal(azure?.apiBase, `http://${H.azure}`);
    assert.doesNotMatch(JSON.stringify(list), new RegExp(RIGHT_KEY));
  });

  test('NEGATIVE TWIN — a wrong key: LiteLLM\'s test says so in one clear sentence, and nothing is registered', { skip }, async () => {
    const conn = await lib!.connectProvider({ preset: 'openai-compatible', name: 'e2e-wrong-key', apiBase: `http://${H.openai}/v1`, apiKey: 'sk-WRONG' }, io);
    assert.equal(conn.ok, true);
    const probe = await lib!.testProviderConnection({ preset: 'openai-compatible', connection: 'e2e-wrong-key', model: 'stub-model-1', mode: 'chat' });
    assert.equal(probe.ok, false);
    assert.match(probe.ok ? '' : probe.message, /rejected the API key/);
    assert.ok(stubLog('openai').some((l) => l.auth_ok === false), 'the stub really saw the wrong key');
  });

  test('NEGATIVE TWIN — a host off the egress allowlist: the OS refuses it with guidance, and the proxy blocks it', { skip }, async () => {
    const refused = await lib!.connectProvider({ preset: 'openai-compatible', name: 'e2e-blocked', apiBase: `http://${H.blocked}/v1`, apiKey: RIGHT_KEY }, io);
    assert.equal(refused.ok, false);
    assert.equal(refused.ok ? '' : refused.code, 'egress_not_allowed');
    assert.match(refused.ok ? '' : refused.guidance ?? '', /llmProviders\.allowHosts/);
    // Even a caller that skips the OS check (straight at LiteLLM, as an admin could) is stopped at the proxy.
    const direct = await lib!.testProviderConnection({ preset: 'openai-compatible', model: 'stub-model-1', mode: 'chat',
      raw: { api_base: `http://${H.blocked}/v1`, api_key: RIGHT_KEY } });
    assert.equal(direct.ok, false);
    assert.match(direct.ok ? '' : direct.message, /egress|could not reach/i);
    assert.deepEqual(stubLog('blocked'), [], 'the blocked provider never received a request');
  });

  test('NEGATIVE TWIN — HTTPS with an untrusted certificate: the handshake fails and the provider sees nothing', { skip }, async () => {
    const conn = await lib!.connectProvider({ preset: 'openai-compatible', name: 'e2e-untrusted', apiBase: `https://${H.untrusted}/v1`, apiKey: RIGHT_KEY }, io);
    assert.equal(conn.ok, true, JSON.stringify(conn));
    const probe = await lib!.testProviderConnection({ preset: 'openai-compatible', connection: 'e2e-untrusted', model: 'tls-model', mode: 'chat' });
    assert.equal(probe.ok, false);
    assert.match(probe.ok ? '' : probe.message, /certificate/i);
    assert.deepEqual(stubLog('untrusted'), [], 'no HTTP request crossed a failed handshake');
  });

  test('NEGATIVE TWIN — an allowlisted name whose DNS answer is private is refused, and nothing is stored', { skip }, async () => {
    const rebind = { ...io!, resolve: async () => [{ address: '10.0.0.5', family: 4 }] };
    const r = await lib!.connectProvider({ preset: 'openai-compatible', name: 'e2e-rebind', apiBase: `http://${H.openai}/v1`, apiKey: RIGHT_KEY }, rebind);
    assert.equal(r.ok, false);
    assert.equal(r.ok ? '' : r.code, 'resolves_internal');
    const list = await lib!.listConnections();
    assert.ok(list.ok && !list.connections.some((c) => c.name === 'e2e-rebind'));
  });

  test('NEGATIVE TWIN — a key without the access group cannot call the new model (the group is the grant)', { skip: skip || !NO_GROUP_KEY ? (skip || 'LLM_E2E_NO_GROUP_KEY unset') : false }, async () => {
    const r = await chat(NO_GROUP_KEY, 'e2e-azure-model');
    assert.equal(r.status, 403, JSON.stringify(r.body));
  });
}

if (PHASE === '2') {
  test('after a gateway restart every connection and model is still there and still answers', { skip }, async () => {
    for (const c of CASES) {
      const r = await chat(AGENT_KEY, c.alias);
      assert.equal(r.status, 200, `${c.alias}: ${JSON.stringify(r.body)}`);
      assert.equal(content(r.body), c.answer);
    }
    const plan = await lib!.readProviderMigration();
    assert.equal(plan.ok, true);
    const rows = plan.ok ? plan.plan.rows : [];
    for (const c of CASES) assert.equal(rows.find((r) => r.model === c.alias)?.update, null, `${c.alias} already in the group`);
    assert.equal(plan.ok && plan.plan.dryRun, true);
  });
}
