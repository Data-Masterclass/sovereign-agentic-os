#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * probe.mjs <base-url> <label> — the Langfuse features the OS uses, against one running Langfuse.
 * Prints one line per check ("ok|FAIL <id> <detail>") and a JSON summary line ("RESULT {...}") that
 * run.sh compares between langfuse-oss and the upstream images.
 *
 * What the OS calls (grep os-ui for /api/public, @langfuse/*):
 *   health + ready (probes, Platform health), OTel ingestion (/api/public/otel: os-ui's
 *   LangfuseSpanProcessor and LiteLLM's langfuse_otel), the ingestion API, trace list/detail
 *   (/api/public/traces), observations (/api/public/observations), metrics (/api/public/metrics),
 *   scores (@langfuse/client score.create), projects, prompts (v2), and the trace UI behind the
 *   server-side NextAuth sign-in (core/infra/tool-sso-langfuse.ts).
 */
import { randomUUID, randomBytes } from 'node:crypto';

const [base, label = 'langfuse'] = process.argv.slice(2);
if (!base) { console.error('usage: probe.mjs <base-url> <label>'); process.exit(2); }
const AUTH = 'Basic ' + Buffer.from('pk-lf-parity:sk-lf-parity').toString('base64');
const results = {};
const ok = (id, detail = '') => { results[id] = 'ok'; console.log(`ok   ${id} ${detail}`); };
const bad = (id, detail = '') => { results[id] = 'FAIL'; console.log(`FAIL ${id} ${detail}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function req(path, opts = {}) {
  const r = await fetch(base + path, { redirect: 'manual', ...opts, headers: { ...(opts.auth === false ? {} : { authorization: AUTH }), ...(opts.headers || {}) } });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: r.status, text, json, headers: r.headers };
}
async function check(id, fn) {
  try { const d = await fn(); if (d === false) bad(id); else ok(id, typeof d === 'string' ? d : ''); }
  catch (e) { bad(id, e.message.slice(0, 300)); }
}
const must = (c, m) => { if (!c) throw new Error(m); };

const traceIngest = randomUUID();
const genIngest = randomUUID();
const traceOtel = randomBytes(16).toString('hex');
const spanOtel = randomBytes(8).toString('hex');
const now = new Date().toISOString();
const promptName = `parity-${Date.now()}`;

await check('health', async () => { const r = await req('/api/public/health', { auth: false }); must(r.status === 200 && r.json?.status === 'OK', `${r.status} ${r.text.slice(0, 120)}`); return `version ${r.json.version}`; });
await check('ready', async () => { const r = await req('/api/public/ready', { auth: false }); must(r.status === 200, `${r.status}`); });
await check('projects', async () => { const r = await req('/api/public/projects'); must(r.status === 200 && r.json?.data?.[0]?.id === 'parity-project', `${r.status} ${r.text.slice(0, 160)}`); });

await check('ingestion-api', async () => {
  const batch = [
    { id: randomUUID(), timestamp: now, type: 'trace-create', body: { id: traceIngest, name: 'parity-ingest', userId: 'u1', tags: ['parity'], metadata: { runId: 'r1' } } },
    { id: randomUUID(), timestamp: now, type: 'generation-create', body: { id: genIngest, traceId: traceIngest, name: 'llm', model: 'm', startTime: now, endTime: now, input: 'hi', output: 'there', usage: { input: 3, output: 5, unit: 'TOKENS' } } },
  ];
  const r = await req('/api/public/ingestion', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ batch }) });
  must(r.status === 207 && r.json?.successes?.length === 2, `${r.status} ${r.text.slice(0, 200)}`);
});

await check('otel-endpoint', async () => {
  const ns = BigInt(Date.now()) * 1000000n;
  const body = { resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'parity' } }] }, scopeSpans: [{ scope: { name: 'parity' }, spans: [{
    traceId: traceOtel, spanId: spanOtel, name: 'parity-otel', kind: 1, startTimeUnixNano: String(ns), endTimeUnixNano: String(ns + 1000000n),
    attributes: [{ key: 'langfuse.observation.type', value: { stringValue: 'generation' } }, { key: 'gen_ai.request.model', value: { stringValue: 'm' } }, { key: 'langfuse.trace.name', value: { stringValue: 'parity-otel' } }],
  }] }] }] };
  const r = await req('/api/public/otel/v1/traces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  must(r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
});

await check('scores', async () => {
  const r = await req('/api/public/scores', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ traceId: traceIngest, name: 'judge', value: 0.9 }) });
  must(r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
});

// The worker processes ingestion asynchronously.
let listed = null;
for (let i = 0; i < 60; i++) {
  const r = await req('/api/public/traces?limit=50');
  const ids = (r.json?.data || []).map((t) => t.id);
  if (ids.includes(traceIngest) && ids.includes(traceOtel)) { listed = ids; break; }
  await sleep(2000);
}
await check('traces-list (worker processed both)', async () => { must(listed, 'both traces did not appear within 120 s'); return `${listed.length} traces`; });
await check('trace-detail', async () => {
  const r = await req(`/api/public/traces/${traceIngest}`);
  must(r.status === 200 && (r.json?.observations || []).some((o) => o.id === genIngest), `${r.status} ${r.text.slice(0, 200)}`);
});
await check('trace-detail (otel)', async () => {
  const r = await req(`/api/public/traces/${traceOtel}`);
  must(r.status === 200 && (r.json?.observations || []).length >= 1, `${r.status} ${r.text.slice(0, 200)}`);
});
await check('observations', async () => {
  const r = await req(`/api/public/observations?traceId=${traceIngest}`);
  must(r.status === 200 && (r.json?.data || []).some((o) => o.id === genIngest), `${r.status} ${r.text.slice(0, 200)}`);
});
await check('metrics', async () => {
  const q = { view: 'traces', metrics: [{ measure: 'count', aggregation: 'count' }], dimensions: [], filters: [], fromTimestamp: new Date(Date.now() - 3600e3).toISOString(), toTimestamp: new Date(Date.now() + 3600e3).toISOString() };
  const r = await req(`/api/public/metrics?query=${encodeURIComponent(JSON.stringify(q))}`);
  must(r.status === 200 && Array.isArray(r.json?.data), `${r.status} ${r.text.slice(0, 200)}`);
});
await check('scores-read', async () => {
  let n = 0;
  for (let i = 0; i < 30 && !n; i++) { const r = await req(`/api/public/v2/scores?traceId=${traceIngest}`); n = (r.json?.data || []).length; if (!n) await sleep(2000); }
  must(n >= 1, 'the score did not appear');
});
await check('prompts-create', async () => {
  const r = await req('/api/public/v2/prompts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: promptName, type: 'text', prompt: 'Hello {{name}}', labels: ['production'] }) });
  must(r.status === 200 || r.status === 201, `${r.status} ${r.text.slice(0, 200)}`);
});
await check('prompts-get', async () => {
  const r = await req(`/api/public/v2/prompts/${promptName}`);
  must(r.status === 200 && r.json?.prompt === 'Hello {{name}}', `${r.status} ${r.text.slice(0, 200)}`);
});

// ---- the trace UI behind the server-side NextAuth sign-in (as core/infra/tool-sso-langfuse.ts does) ----
let cookie = '';
await check('ui-sign-in', async () => {
  const csrf = await req('/api/auth/csrf', { auth: false });
  must(csrf.status === 200 && csrf.json?.csrfToken, `csrf ${csrf.status}`);
  const c1 = (csrf.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  const login = await req('/api/auth/callback/credentials', {
    auth: false, method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: c1 },
    body: new URLSearchParams({ csrfToken: csrf.json.csrfToken, email: 'parity@example.com', password: 'parity-password-1', json: 'true', redirect: 'false' }).toString(),
  });
  const set = (login.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]);
  must(set.some((c) => /session-token=/.test(c)), `login ${login.status}: no session cookie`);
  cookie = [c1, ...set].filter(Boolean).join('; ');
});
const basePath = new URL(base).pathname.replace(/\/$/, '');
await check('ui-trace-list-page', async () => {
  const r = await req('/project/parity-project/traces', { auth: false, headers: { cookie } });
  must(r.status === 200, `${r.status}`);
  const assets = [...r.text.matchAll(/(?:src|href)="(\/[^"]*_next\/[^"]+)"/g)].map((m) => m[1]);
  must(assets.length > 0, 'no /_next assets in the page');
  const outside = assets.filter((a) => !a.startsWith(`${basePath}/_next/`));
  must(outside.length === 0, `assets outside ${basePath || '/'}: ${outside.slice(0, 3).join(', ')}`);
  const a = await fetch(new URL(assets.find((x) => x.endsWith('.js')) || assets[0], base).href);
  must(a.status === 200, `asset ${a.status}`);
  return `${assets.length} assets under ${basePath || '/'}/_next`;
});
await check('ui-trace-detail-page', async () => {
  const r = await req(`/project/parity-project/traces/${traceIngest}`, { auth: false, headers: { cookie } });
  must(r.status === 200, `${r.status}`);
});
await check('ui-trpc-trace', async () => {
  const input = encodeURIComponent(JSON.stringify({ 0: { json: { traceId: traceIngest, projectId: 'parity-project' } } }));
  const r = await req(`/api/trpc/traces.byIdWithObservationsAndScores?batch=1&input=${input}`, { auth: false, headers: { cookie } });
  must(r.status === 200 && JSON.stringify(r.json).includes(genIngest), `${r.status} ${r.text.slice(0, 200)}`);
});
await check('ui-trpc-session', async () => {
  const r = await req('/api/auth/session', { auth: false, headers: { cookie } });
  must(r.status === 200 && r.json?.user?.email === 'parity@example.com', `${r.status} ${r.text.slice(0, 160)}`);
});

// ---- Enterprise Edition surfaces: informational (the expected difference) ----
const ee = {};
for (const [id, path] of [['admin-api', '/api/admin/organizations'], ['org-api-keys', '/api/public/organizations/apiKeys']]) {
  const r = await req(path, { auth: false, headers: { authorization: 'Bearer parity-admin-key' } });
  ee[id] = r.status; console.log(`info ${id} -> ${r.status} ${r.text.slice(0, 140).replace(/\s+/g, ' ')}`);
}
console.log('RESULT ' + JSON.stringify({ label, results, ee }));
process.exit(Object.values(results).includes('FAIL') ? 1 : 0);
