/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        admin
 * FEATURE:    Provider endpoints cannot point the gateway into the cluster or a private network (SSRF)
 * USER STORY: As a platform admin, a provider base URL that names — or RESOLVES to — a cluster Service,
 *             a private, link-local or metadata address is refused, unless the deployment names it as a
 *             local model server (llmProviders.localModels), which is how an in-cluster Ollama or vLLM
 *             is connected on purpose. A metadata address is refused even then.
 * ARCHITECTURE:
 *   - `checkProviderEndpoint` decides on the RESOLVED addresses, not the string: an allowlisted public
 *     name whose DNS answer is 10.x is refused. The resolver is injected here; production uses
 *     node:dns `lookup(host, {all:true})`, the same resolver view the gateway pod has in the cluster.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkProviderEndpoint, presetById } from '@tabs/admin/lib/llm-providers';

const answers = (map: Record<string, string[]>) => async (host: string) => {
  const a = map[host];
  if (!a) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  return a.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};
const base = { allow: ['openai.azure.com', 'api.mistral.ai', 'evil.example.com'], noProxy: ['mock-model'], localModels: ['ollama', '.models.svc'] };
const azure = presetById('azure')!;
const ollama = presetById('ollama')!;
const compat = presetById('openai-compatible')!;

test('a public, allowlisted host that resolves to a public address is allowed through the proxy', async () => {
  const v = await checkProviderEndpoint(azure, 'https://acme.openai.azure.com', { ...base, resolve: answers({ 'acme.openai.azure.com': ['20.50.1.2'] }) });
  assert.deepEqual({ ok: v.ok, route: v.route, host: v.host }, { ok: true, route: 'egress-proxy', host: 'acme.openai.azure.com' });
});

test('DNS decides, not the string: an allowlisted name that resolves into a private range is refused', async () => {
  for (const addr of ['10.0.0.5', '172.20.1.1', '192.168.1.9', '100.64.3.4', '127.0.0.1', '169.254.169.254', 'fd00::1', 'fe80::1', '::1', '::ffff:10.1.2.3', '0.0.0.0']) {
    const v = await checkProviderEndpoint(compat, 'https://evil.example.com/v1', { ...base, resolve: answers({ 'evil.example.com': ['203.0.113.7', addr] }) });
    assert.equal(v.ok, false, addr);
    assert.equal(v.code, 'resolves_internal', addr);
  }
});

test('a host that does not resolve is refused, with the reason', async () => {
  const v = await checkProviderEndpoint(azure, 'https://nope.openai.azure.com', { ...base, resolve: answers({}) });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'unresolvable');
});

test('Service names, *.svc and private literals are refused unless named in llmProviders.localModels', async () => {
  const resolve = answers({ 'vllm.other.svc': ['10.96.0.20'], 'mock-model': ['10.96.0.9'], 'ollama': ['10.96.0.10'], 'vllm.models.svc': ['10.96.0.11'] });
  for (const url of ['http://vllm.other.svc:8000/v1', 'http://mock-model:8080/v1', 'http://10.1.2.3:8000/v1', 'http://192.168.0.4:11434']) {
    const v = await checkProviderEndpoint(compat, url, { ...base, resolve });
    assert.equal(v.ok, false, url);
    assert.equal(v.code, 'internal_not_listed', url);
    assert.match(v.guidance ?? '', /llmProviders\.localModels/);
  }
  const named = await checkProviderEndpoint(ollama, 'http://ollama:11434', { ...base, resolve });
  assert.deepEqual({ ok: named.ok, route: named.route }, { ok: true, route: 'in-cluster' });
  const suffix = await checkProviderEndpoint(compat, 'http://vllm.models.svc:8000/v1', { ...base, resolve });
  assert.deepEqual({ ok: suffix.ok, route: suffix.route }, { ok: true, route: 'in-cluster' });
});

test('a metadata or loopback answer is refused even for a listed local model', async () => {
  for (const addr of ['169.254.169.254', '127.0.0.1', '::1']) {
    const v = await checkProviderEndpoint(ollama, 'http://ollama:11434', { ...base, resolve: answers({ ollama: [addr] }) });
    assert.equal(v.ok, false, addr);
    assert.equal(v.code, 'resolves_internal', addr);
  }
});

test('the string rules still apply first: off the allowlist is refused without a lookup', async () => {
  let looked = false;
  const v = await checkProviderEndpoint(azure, 'https://other.example.org', { ...base, resolve: async () => { looked = true; return [{ address: '1.1.1.1', family: 4 }]; } });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'egress_not_allowed');
  assert.equal(looked, false);
});
