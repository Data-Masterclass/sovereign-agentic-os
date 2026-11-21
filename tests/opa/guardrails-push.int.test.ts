/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * guardrails-push.int.test — today's push path (no bundles) on the chart's REAL OPA 1.22.4:
 *   - a call that reports a violated guardrail is DENIED by the module os-ui uploads, and a call
 *     with no violation is allowed;
 *   - TWIN: the previous module text (reading `data.guardrails`) allows the same violating call, so
 *     the test can tell the fixed module from the old one;
 *   - the boot reconcile (`restoreGuardrails`, the registered OPA state source) re-uploads the
 *     module, replacing an old live one, and the call is denied afterwards;
 *   - the Rules panel's "applied" row is `ok` only when OPA really denies a violating call.
 *
 * Run: OPA_IT_URL=http://127.0.0.1:18181 node --experimental-test-module-mocks --import ./scripts/test-setup.mjs --test ../tests/opa/guardrails-push.int.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const OPA = process.env.OPA_IT_URL;
if (!OPA) throw new Error('guardrails-push.int.test needs OPA_IT_URL (a real OPA container)');
process.env.OPA_URL = OPA;
process.env.OS_OPA_DATA_BUNDLE = '';
{
  const { createServer } = await import('node:http');
  const srv = createServer((req, res) => {
    const url = req.url ?? '/';
    const send = (b: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    req.resume();
    req.on('end', () => {
      if (url.includes('/_count')) return send({ count: 0 });
      if (url.includes('/_search')) return send({ timed_out: false, _shards: { total: 1, successful: 1, failed: 0 }, hits: { total: { value: 0, relation: 'eq' }, hits: [] } });
      return send({ result: 'ok', acknowledged: true });
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  srv.unref();
  process.env.OPENSEARCH_URL = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
}

const { parseWorkflow, serializeWorkflow } = await import('@tabs/knowledge/lib/schema');
const { compileGuardrails } = await import('@tabs/knowledge/lib/guardrails');
const { applyGuardrails, restoreGuardrails } = await import('@tabs/knowledge/lib/guardrails-apply');
const store = await import('@tabs/knowledge/lib/store');
const { WF_MD } = await import('@tabs/knowledge/lib/git/fixtures');

async function allow(pkg: string, violations: string[]): Promise<unknown> {
  const res = await fetch(`${OPA}/v1/data/${pkg.replace(/\./g, '/')}/allow`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: { violations } }) });
  return ((await res.json()) as { result?: unknown }).result;
}
async function putPolicy(id: string, rego: string): Promise<void> {
  const r = await fetch(`${OPA}/v1/policies/${id}`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: rego });
  assert.equal(r.status, 200, await r.text());
}

test('the uploaded module denies a reported violation and allows a clean call; the old module text did not', async () => {
  const wf = parseWorkflow(WF_MD);
  const c = compileGuardrails(wf);
  const r = await applyGuardrails(wf);
  assert.equal(r.apply.policy, 'opa-live');
  assert.equal(r.apply.status, 'ok', r.apply.detail);
  assert.equal(await allow(c.packagePath, []), true, 'no violation → allowed');
  assert.equal(await allow(c.packagePath, ['sr1']), false, 'a reported violation → denied');
  assert.equal(await allow(c.packagePath, ['not_a_guardrail']), true, 'another workflow’s id is ignored');

  // TWIN: the previous module text, same data path.
  await putPolicy(`knowledge-${c.workflowId}`, c.rego.replace(`data.${c.packagePath}.guardrails[_].id`, 'data.guardrails[_].id'));
  assert.equal(await allow(c.packagePath, ['sr1']), true, 'the old module allowed the violating call');
});

test('the boot reconcile re-uploads the module, so an old live module is replaced and the call is denied', async () => {
  store.__resetStore();
  await store.ensureHydrated();
  const amir = { id: 'amir', domains: ['sales'], role: 'builder' as const };
  const rec = store.createWorkflow(amir, { title: 'Bank Submission', domain: 'sales' });
  const md = serializeWorkflow({ ...parseWorkflow(WF_MD), id: rec.id, title: 'Bank Submission', domain: 'sales', visibility: 'Personal', status: 'draft' });
  store.updateWorkflow(rec.id, amir, { md });
  const c = compileGuardrails(parseWorkflow(md));
  // A live module uploaded before the fix.
  await putPolicy(`knowledge-${rec.id}`, c.rego.replace(`data.${c.packagePath}.guardrails[_].id`, 'data.guardrails[_].id'));
  assert.equal(await allow(c.packagePath, ['wr2']), true, 'before: the old live module allows');
  const res = await restoreGuardrails();
  assert.equal(res.ok, true, res.detail);
  assert.equal(await allow(c.packagePath, ['wr2']), false, 'after the boot reconcile: denied');
});

test('the Rules panel ticks "enforced" only when OPA really denies a violating call', async () => {
  const wf = parseWorkflow(WF_MD);
  const ok = await applyGuardrails(wf);
  assert.equal(ok.apply.verified, true);
  assert.match(ok.apply.detail, /denies a call that reports a violated guardrail/);
});
