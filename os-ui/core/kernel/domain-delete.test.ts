/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The delete-domain engine's contract: dry run by default, admin only, typed
 *             confirmation, the 2 h backup gate, audited steps, stop on the first failure, resume
 * USER STORY: As the admin deleting a domain I want a run that never starts by accident, never
 *             skips a failure, and finishes a half-done delete when I run it again.
 * ARCHITECTURE:
 *   - Engine logic only: the components are in-memory stand-ins whose state the test reads back.
 *     The components' REAL removals are proven against real Trino/Polaris/OPA/OpenSearch/LiteLLM
 *     in tabs/admin/lib/domain-delete.int.test.ts.
 *   - Each rule has a negative twin: the same call with one guard removed must change the result.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deleteDomain, checkBackup, planLines, type DomainDeleteComponent, type AuditFn } from '@core/kernel/domain-delete';

const admin = { id: 'alex', role: 'admin' as const, domains: ['k'] };
const builder = { id: 'bob', role: 'builder' as const, domains: ['k'] };
// The delete window is its own rule (domain-delete-window.test.ts); here it is open.
const open = () => true;
const freshBackup = async () => ({ ok: true as const, name: 'velero-x', at: new Date(Date.now() - 10 * 60_000).toISOString() });

function store(name: string, ids: string[], opts: { failOn?: string; keep?: string[]; blocked?: string[] } = {}) {
  const live = new Set(ids);
  const c: DomainDeleteComponent & { live: Set<string>; failOn?: string } = {
    component: name,
    live,
    failOn: opts.failOn,
    async plan() {
      return {
        component: name,
        remove: [...live].map((id) => ({ component: name, kind: 'thing', id, label: id })),
        keep: (opts.keep ?? []).map((id) => ({ component: name, kind: 'thing', id, label: id, reason: 'mapped by another domain' })),
        blocked: (opts.blocked ?? []).map((id) => ({ component: name, kind: 'stuck', id, label: id, reason: 'no delete path' })),
      };
    },
    async remove(item) {
      if (c.failOn === item.id) throw new Error(`boom on ${item.id}`);
      live.delete(item.id);
      return `gone ${item.id}`;
    },
  };
  return c;
}

function audits() {
  const log: Parameters<AuditFn>[0][] = [];
  return { log, fn: ((e) => log.push(e)) as AuditFn };
}

test('a dry run is the default and removes nothing', async () => {
  const a = store('a', ['1', '2'], { keep: ['shared'] });
  const au = audits();
  const r = await deleteDomain('k', {}, { actor: admin, components: [a], audit: au.fn, backup: freshBackup, deleteWindow: open });
  assert.equal(r.status, 'planned');
  assert.equal(r.plan.totals.remove, 2);
  assert.equal(r.plan.totals.keep, 1);
  assert.deepEqual([...a.live].sort(), ['1', '2']);
  assert.ok(planLines(r.plan).some((l) => l.includes('KEEP thing shared')));
  // twin: dryRun:false with confirmation does remove
  const r2 = await deleteDomain('k', { dryRun: false, confirm: 'k' }, { actor: admin, components: [a], audit: au.fn, backup: freshBackup, deleteWindow: open });
  assert.equal(r2.status, 'done');
  assert.equal(a.live.size, 0);
});

test('only an admin may plan or run', async () => {
  const au = audits();
  await assert.rejects(deleteDomain('k', {}, { actor: builder, components: [store('a', ['1'])], audit: au.fn, backup: freshBackup, deleteWindow: open }), /requires an admin/);
  assert.equal(au.log[0].result, 'denied');
});

test('a run without the typed domain id is refused', async () => {
  const a = store('a', ['1']);
  const r = await deleteDomain('k', { dryRun: false, confirm: 'K ' }, { actor: admin, components: [a], audit: audits().fn, backup: freshBackup, deleteWindow: open });
  assert.equal(r.status, 'refused');
  assert.equal(a.live.size, 1);
});

test('the backup gate: older than 2 h refuses, the explicit flag overrides', async () => {
  const old = async () => ({ ok: true as const, name: 'velero-old', at: new Date(Date.now() - 3 * 3600_000).toISOString() });
  const a = store('a', ['1']);
  const r = await deleteDomain('k', { dryRun: false, confirm: 'k' }, { actor: admin, components: [a], audit: audits().fn, backup: old, deleteWindow: open });
  assert.equal(r.status, 'refused');
  assert.match((r as { reason: string }).reason, /older than 2 hours/);
  assert.equal(a.live.size, 1);
  const none = await checkBackup(async () => ({ ok: false, reason: 'velero unreachable' }), false);
  assert.equal(none.ok, false);
  const r2 = await deleteDomain('k', { dryRun: false, confirm: 'k', iHaveABackup: true }, { actor: admin, components: [a], audit: audits().fn, backup: old, deleteWindow: open });
  assert.equal(r2.status, 'done');
});

test('a blocked object (no delete path) refuses the run and is shown in the plan', async () => {
  const a = store('a', ['1'], { blocked: ['approval-9'] });
  const r = await deleteDomain('k', { dryRun: false, confirm: 'k' }, { actor: admin, components: [a], audit: audits().fn, backup: freshBackup, deleteWindow: open });
  assert.equal(r.status, 'refused');
  assert.match((r as { reason: string }).reason, /no delete path/);
  assert.equal(a.live.size, 1);
  assert.ok(planLines(r.plan).some((l) => l.includes('BLOCKED stuck approval-9')));
});

test('the first failure stops the run, every step is audited, and a re-run finishes it', async () => {
  const a = store('a', ['1', '2']);
  const b = store('b', ['3'], { failOn: '3' });
  const c = store('c', ['4']);
  const au = audits();
  const deps = { actor: admin, components: [a, b, c], audit: au.fn, backup: freshBackup, deleteWindow: open };
  const r = await deleteDomain('k', { dryRun: false, confirm: 'k' }, deps);
  assert.equal(r.status, 'failed');
  if (r.status !== 'failed') return;
  assert.equal(r.failed.id, '3');
  assert.deepEqual(r.remaining.map((x) => x.id), ['3', '4']);
  assert.equal(c.live.size, 1, 'nothing after the failure ran (no silent skip past it)');
  const steps = au.log.filter((e) => e.action === 'domain.delete.step');
  assert.deepEqual(steps.map((s) => `${s.target}:${s.result}`), ['a:thing:1:ok', 'a:thing:2:ok', 'b:thing:3:error']);
  // resume: fix the cause, run again — only what is left is planned and removed
  b.failOn = undefined;
  const r2 = await deleteDomain('k', { dryRun: false, confirm: 'k' }, deps);
  assert.equal(r2.status, 'done');
  if (r2.status !== 'done') return;
  assert.deepEqual(r2.done.map((d) => d.id), ['3', '4']);
  assert.equal(au.log.at(-1)!.action, 'domain.delete');
  assert.equal(au.log.at(-1)!.result, 'ok');
});

test('a component whose plan fails fails the whole plan (no partial plan)', async () => {
  const bad: DomainDeleteComponent = { component: 'bad', plan: async () => { throw new Error('unreachable'); }, remove: async () => undefined };
  await assert.rejects(deleteDomain('k', {}, { actor: admin, components: [store('a', ['1']), bad], audit: audits().fn, backup: freshBackup, deleteWindow: open }), /Planning bad failed/);
});

test('a plan-only door (MCP) refuses a run; the twin with allowRun runs', async () => {
  const a = store('a', ['1']);
  await assert.rejects(deleteDomain('k', { dryRun: false, confirm: 'k' }, { actor: admin, components: [a], audit: audits().fn, backup: freshBackup, deleteWindow: open, allowRun: false }), /may only plan/);
  assert.equal(a.live.size, 1);
  const ok = await deleteDomain('k', {}, { actor: admin, components: [a], audit: audits().fn, backup: freshBackup, deleteWindow: open, allowRun: false });
  assert.equal(ok.status, 'planned', 'a dry run is still allowed');
  const r = await deleteDomain('k', { dryRun: false, confirm: 'k' }, { actor: admin, components: [a], audit: audits().fn, backup: freshBackup, deleteWindow: open, allowRun: true });
  assert.equal(r.status, 'done');
});

test('an invalid target is refused before anything is planned', async () => {
  let planned = false;
  const spy: DomainDeleteComponent = { component: 's', plan: async () => { planned = true; return { component: 's', remove: [], keep: [] }; }, remove: async () => undefined };
  const validateTarget = async (id: string) => { if (id === 'platform') throw Object.assign(new Error('reserved'), { status: 400 }); };
  await assert.rejects(deleteDomain('platform', {}, { actor: admin, components: [spy], audit: audits().fn, backup: freshBackup, deleteWindow: open, validateTarget }), /reserved/);
  assert.equal(planned, false);
  await deleteDomain('k', {}, { actor: admin, components: [spy], audit: audits().fn, backup: freshBackup, deleteWindow: open, validateTarget });
  assert.equal(planned, true);
});

test('a failing preflight (e.g. an old query-tool) refuses the run before anything is removed', async () => {
  const a = store('a', ['1']);
  const r = await deleteDomain('k', { dryRun: false, confirm: 'k' }, { actor: admin, components: [a], audit: audits().fn, backup: freshBackup, deleteWindow: open, preflight: async () => 'query-tool too old' });
  assert.equal(r.status, 'refused');
  assert.equal(a.live.size, 1);
  const ok = await deleteDomain('k', { dryRun: false, confirm: 'k' }, { actor: admin, components: [a], audit: audits().fn, backup: freshBackup, deleteWindow: open, preflight: async () => null });
  assert.equal(ok.status, 'done');
});
