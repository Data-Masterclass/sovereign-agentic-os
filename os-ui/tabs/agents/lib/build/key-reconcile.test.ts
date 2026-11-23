/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The continuous key reconcile: every agent system's key at the gateway is compared with
 *             what its definition says, on a timer, and a difference is an ALERT (default) or is
 *             corrected (per system, only when an admin switched that on).
 * USER STORY: As a platform admin I edit a key in LiteLLM's own UI and the OS shows it as drift
 *             within minutes instead of leaving it unnoticed until the next Build. The OS does not
 *             overwrite my edit unless I told it to for that system.
 * ARCHITECTURE:
 *   - The gateway here is an in-memory fake with LiteLLM's key semantics; the SAME reconcile is proven
 *     against the real LiteLLM image in `key-reconcile.e2e.test.ts`. Each behaviour has a negative twin.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveKek, memorySystemKeyJournal, memorySystemKeyStore, tokenIdOf } from '@core/infra/agent-system-keys';
import { orchestrateBuild } from '@tabs/agents/lib/build/orchestrate';
import { makeLiveAdapters, type LiteLlmClient, type LiteLlmKeyInput, type LiteLlmKeyState, type LiveDeps } from '@tabs/agents/lib/build/live';
import { parseAutoCorrect, reapplySystemKeyWith, runKeyReconcile, type KeyReconcileIo } from '@tabs/agents/lib/build/key-reconcile';
import { ALLOWED_TOOLS_REV } from '@tabs/agents/lib/build/run-tools';

const YAML = `
system: { name: Desk, domain: sales, visibility: Personal }
entrypoint: worker
grants:
  tools: [retrieve]
agents:
  - { id: worker, role: w, agent_md: "# Worker", memory_md: "", tools: [retrieve], model: sovereign-default }
`;
const KEK = deriveKek('unit-test-key-encryption-secret-0123456789');

type Gw = LiteLlmClient & { rows: Map<string, LiteLlmKeyState[]>; updates: number; unreachable: boolean };

/** A LiteLLM-shaped key store: alias → keys (normally one), addressed by token id. */
function gateway(): Gw {
  const rows = new Map<string, LiteLlmKeyState[]>();
  const state = (i: LiteLlmKeyInput, tokenId: string): LiteLlmKeyState => ({
    tokenId, models: [...i.models], maxBudget: i.maxBudget, budgetDuration: i.budgetDuration, rpmLimit: i.rpmLimit,
    tpmLimit: i.tpmLimit, maxParallelRequests: i.maxParallelRequests, allowedTools: [...i.allowedTools],
    // Stamped as the real client stamps it (`metadata.os_allowed_tools_rev`, live-clients `keyProperties`).
    allowedToolsRev: ALLOWED_TOOLS_REV,
  });
  const gw: Gw = {
    rows, updates: 0, unreachable: false,
    async keysByAlias(alias) {
      if (gw.unreachable) throw new Error('LiteLLM /key/list failed (unreachable)');
      return (rows.get(alias) ?? []).map((k) => ({ ...k }));
    },
    async generateKey(i, key) { rows.set(i.alias, [...(rows.get(i.alias) ?? []), state(i, tokenIdOf(key))]); },
    async updateKey(tokenId, i) {
      gw.updates += 1;
      for (const [a, ks] of rows) rows.set(a, ks.map((k) => (k.tokenId === tokenId ? state(i, tokenId) : k)));
    },
    async deleteKey(tokenId) { for (const [a, ks] of rows) rows.set(a, ks.filter((k) => k.tokenId !== tokenId)); },
    async renameKey(tokenId, alias) {
      for (const [a, ks] of [...rows]) {
        const hit = ks.find((k) => k.tokenId === tokenId);
        if (hit) { rows.set(a, ks.filter((k) => k !== hit)); rows.set(alias, [...(rows.get(alias) ?? []), hit]); }
      }
    },
    async expireKey() {},
    async models() { return []; },
  };
  return gw;
}

function setup() {
  const gw = gateway();
  const deps: LiveDeps = {
    opa: { putGrants: async () => undefined, mergeRequiresApproval: async () => undefined, decision: async () => ({ effect: 'allow', reason: '' }) },
    litellm: gw,
    langfuse: { ensureProject: async () => undefined, tracesFor: async () => 0 },
    keys: { store: memorySystemKeyStore(), journal: memorySystemKeyJournal(), kek: () => KEK, retireGraceSeconds: 0 },
    caps: { maxBudget: 5, budgetDuration: '7d', modelMaxBudget: {}, rpmLimit: 300, tpmLimit: 1_000_000, maxParallelRequests: 8 },
    runModels: () => ['sovereign-default'],
  };
  const audits: { action: string; subject: string; detail?: Record<string, unknown> }[] = [];
  const io = (over: Partial<KeyReconcileIo> = {}): KeyReconcileIo => ({
    systems: async () => [{ id: 'sys_rc', domain: 'sales', owner: 'u1', yaml: YAML }],
    governYaml: async (y) => y,
    deps,
    autoCorrect: new Set<string>(),
    previous: null,
    log: () => undefined,
    audit: ((e: { action: string; subject: string; detail?: Record<string, unknown> }) => { audits.push(e); }) as never,
    ...over,
  });
  const build = () => orchestrateBuild({ yaml: YAML, systemId: 'sys_rc', adapters: makeLiveAdapters(deps).filter((a) => a.tool === 'litellm') });
  const key = () => gw.rows.get('os-sys_rc')![0];
  return { gw, deps, io, build, audits, key };
}

test('a key that matches its definition is in sync: no alert', async () => {
  const t = setup();
  assert.equal((await t.build()).ok, true);
  const r = await runKeyReconcile(t.io());
  assert.deepEqual([r.ok, r.scanned, r.inSync, r.entries.length], [true, 1, 1, 0]);
});

test('an edit made in the gateway is reported as drift and NOT overwritten (alert-only is the default)', async () => {
  const t = setup();
  await t.build();
  t.key().maxBudget = 500;
  t.key().rpmLimit = 5;
  const before = t.gw.updates;
  const r = await runKeyReconcile(t.io());
  assert.equal(r.entries.length, 1);
  const e = r.entries[0];
  assert.deepEqual([e.systemId, e.alias, e.kind, e.action], ['sys_rc', 'os-sys_rc', 'drift', 'alert']);
  assert.ok(e.changes.some((c) => c.startsWith('budget $500 → $5')), e.changes.join('|'));
  assert.ok(e.changes.some((c) => c.startsWith('requests/min 5 → 300')), e.changes.join('|'));
  assert.equal(t.gw.updates, before, 'alert-only: the gateway was not written');
  assert.equal(t.key().maxBudget, 500, 'the hand edit stands');
});

test('NEGATIVE TWIN: the same drift on a system an admin switched to auto-correct IS corrected, and audited', async () => {
  const t = setup();
  await t.build();
  t.key().maxBudget = 500;
  const r = await runKeyReconcile(t.io({ autoCorrect: new Set(['sys_rc']) }));
  assert.equal(t.key().maxBudget, 5, 'the key is back to what the definition says');
  assert.deepEqual(r.entries.map((e) => e.action), ['corrected']);
  const a = t.audits.find((x) => x.action === 'gateway.key.reconcile');
  assert.ok(a, 'the correction is in the audit log');
  assert.equal(a!.subject, 'os-sys_rc');
  // And a second pass is clean: nothing is rewritten when nothing differs.
  const again = await runKeyReconcile(t.io({ autoCorrect: new Set(['sys_rc']) }));
  assert.equal(again.entries.length, 0);
});

test('auto-correct is PER SYSTEM: listing another system leaves this one alert-only', async () => {
  const t = setup();
  await t.build();
  t.key().maxBudget = 500;
  const r = await runKeyReconcile(t.io({ autoCorrect: new Set(['some_other_system']) }));
  assert.equal(r.entries[0].action, 'alert');
  assert.equal(t.key().maxBudget, 500);
});

test('a key whose allowed_tools metadata was dropped is drift (a missing value is not "no drift")', async () => {
  const t = setup();
  await t.build();
  delete t.key().allowedTools;
  const r = await runKeyReconcile(t.io());
  assert.equal(r.entries.length, 1);
  assert.match(r.entries[0].changes.join('|'), /allowed tools not recorded/);
});

test('a key the gateway no longer holds is reported as missing; a system that was never built is not', async () => {
  const t = setup();
  await t.build();
  t.gw.rows.delete('os-sys_rc');
  const gone = await runKeyReconcile(t.io());
  assert.deepEqual(gone.entries.map((e) => [e.kind, e.action]), [['missing', 'alert']]);
  assert.match(gone.entries[0].changes.join('|'), /deleted|no longer/i);
  // Twin: no stored key and no gateway key = a system nobody built yet. Not an alert.
  const fresh = setup();
  const r = await runKeyReconcile(fresh.io());
  assert.deepEqual([r.entries.length, r.notBuilt, r.inSync], [0, 1, 0]);
});

test('two keys under one alias, or a key that is not the stored one, are reported', async () => {
  const t = setup();
  await t.build();
  t.gw.rows.get('os-sys_rc')!.push({ ...t.key(), tokenId: tokenIdOf('sk-a-second-key') });
  assert.deepEqual((await runKeyReconcile(t.io())).entries.map((e) => e.kind), ['duplicate']);
  const u = setup();
  await u.build();
  u.gw.rows.set('os-sys_rc', [{ ...u.key(), tokenId: tokenIdOf('sk-somebody-elses') }]);
  assert.deepEqual((await runKeyReconcile(u.io())).entries.map((e) => e.kind), ['not-ours']);
});

test('a gateway that cannot be read is "could not check", never "in sync"', async () => {
  const t = setup();
  await t.build();
  t.gw.unreachable = true;
  const r = await runKeyReconcile(t.io());
  assert.equal(r.ok, false);
  assert.equal(r.inSync, 0);
  assert.equal(r.entries.length, 0);
  assert.deepEqual(r.unchecked.map((u) => u.systemId), ['sys_rc']);
  assert.match(r.unchecked[0].error, /unreachable/);
  // an unhydrated registry: nothing is checked, and the report says why
  const n = await runKeyReconcile(t.io({ systems: async () => null }));
  assert.deepEqual([n.ok, n.scanned, n.error], [false, 0, 'registry not hydrated']);
});

test('how long a drift has been standing is kept from one pass to the next', async () => {
  const t = setup();
  await t.build();
  t.key().maxBudget = 500;
  const first = await runKeyReconcile(t.io({ now: () => 1_000 }));
  const second = await runKeyReconcile(t.io({ now: () => 9_000, previous: first }));
  assert.equal(second.entries[0].firstSeenAt, 1_000);
  assert.equal(second.at, 9_000);
});

test('a replacement in flight (journal) is not reported while it completes', async () => {
  const t = setup();
  await t.build();
  t.key().maxBudget = 500;
  const staged = { record: (await t.deps.keys.store.get('sys_rc'))!, retire: [], stagedAt: 1 };
  await t.deps.keys.journal.stage(staged);
  const r = await runKeyReconcile(t.io());
  assert.deepEqual([r.entries.length, r.inFlight], [0, 1]);
});

test('re-apply from the OS puts the key back to its definition WITHOUT rotating the value', async () => {
  const t = setup();
  await t.build();
  const token = t.key().tokenId;
  t.key().maxBudget = 500;
  const out = await reapplySystemKeyWith('sys_rc', YAML, t.deps);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(t.key().maxBudget, 5);
  assert.equal(t.key().tokenId, token, 'same key value — nothing a running system holds was invalidated');
});

test('parseAutoCorrect: a list of system ids, "*" for all, empty for none; junk is dropped', () => {
  assert.deepEqual([...(parseAutoCorrect('sys_a, sys_b') as Set<string>)].sort(), ['sys_a', 'sys_b']);
  assert.equal(parseAutoCorrect('*'), 'all');
  assert.equal((parseAutoCorrect('') as Set<string>).size, 0);
  assert.equal((parseAutoCorrect(undefined) as Set<string>).size, 0);
});

test('re-apply is AUDITED with who, which key, what had drifted and the outcome — and the audit is written on failure too', async () => {
  const { reapplyAudited } = await import('@tabs/agents/lib/build/key-reconcile');
  const t = setup();
  await t.build();
  t.key().maxBudget = 500;
  const drift = (await runKeyReconcile(t.io())).entries[0];
  const ok = await reapplyAudited({ systemId: 'sys_rc', yaml: YAML, domain: 'sales', actor: 'u_admin', deps: t.deps, drift, audit: ((e: never) => t.audits.push(e)) as never });
  assert.equal(ok.ok, true);
  const a = t.audits.filter((x) => x.action === 'gateway.key.reapply');
  assert.equal(a.length, 1);
  assert.deepEqual([a[0].subject, (a[0] as { actor?: string }).actor, a[0].detail?.outcome, a[0].detail?.kind], ['os-sys_rc', 'u_admin', 'reapplied', 'drift']);
  // NEGATIVE TWIN: a failing gateway is still audited, as a failure.
  t.gw.updateKey = async () => { throw new Error('LiteLLM /key/update failed (500)'); };
  t.key().maxBudget = 500;
  const bad = await reapplyAudited({ systemId: 'sys_rc', yaml: YAML, domain: 'sales', actor: 'u_admin', deps: t.deps, audit: ((e: never) => t.audits.push(e)) as never });
  assert.equal(bad.ok, false);
  assert.equal(t.audits.filter((x) => x.action === 'gateway.key.reapply').at(-1)!.detail?.outcome, 'failed');
});

// ---- A key stamped by an EARLIER OS release (dev, 23 Nov 2026) ----------------------------------
// The OS changed what a run offers (workflow tools, delegate_to_worker); every key written before
// still carries the old list, and the gateway refuses every run with tool_access_denied. Nobody
// edited those keys, so the reconcile re-stamps them on its own — and ONLY those.

/** What the pre-fix OS stamped for YAML: the grant vocabulary, no lead tool, no revision. */
const stampedByOldRelease = (k: LiteLlmKeyState) => {
  k.allowedTools = ['retrieve', 'search_knowledge', 'list_knowledge'];
  delete k.allowedToolsRev;
};

test('STALE STAMP: a key whose allowed tools an earlier OS release stamped is re-stamped automatically (auto-correct off), and audited', async () => {
  const t = setup();
  await t.build();
  stampedByOldRelease(t.key());
  const r = await runKeyReconcile(t.io());
  assert.deepEqual(r.entries.map((e) => [e.kind, e.action]), [['drift', 'corrected']]);
  assert.ok(t.key().allowedTools!.includes('search_knowledge'), t.key().allowedTools!.join(','));
  assert.ok(!t.key().allowedTools!.includes('retrieve'), 'the raw legacy name is gone');
  assert.equal(t.key().allowedToolsRev, ALLOWED_TOOLS_REV);
  const a = t.audits.find((x) => x.action === 'gateway.key.reconcile');
  assert.ok(a, 'the re-stamp is audited');
  assert.equal(a!.detail?.cause, 'stale-allowed-tools-stamp');
  assert.equal((await runKeyReconcile(t.io())).entries.length, 0, 'the next pass is clean');
});

// Rev 3 (23 Nov 2026): agent runs no longer offer the lead tools. A rev-2 key that carries them is a NARROWING the OS
// made, not a person's edit: re-stamped automatically, and the lead tools are gone from it.
test('STALE STAMP (rev 2 → 3): a key stamped with the lead tools is re-stamped without them, automatically and audited', async () => {
  const t = setup();
  await t.build();
  const k = t.key();
  k.allowedTools = [...k.allowedTools!, 'delegate_to_worker', 'escalate_to_strong'];
  k.allowedToolsRev = 2;
  const r = await runKeyReconcile(t.io());
  assert.deepEqual(r.entries.map((e) => [e.kind, e.action]), [['drift', 'corrected']]);
  for (const tool of ['delegate_to_worker', 'escalate_to_strong']) assert.ok(!t.key().allowedTools!.includes(tool), t.key().allowedTools!.join(','));
  assert.equal(t.key().allowedToolsRev, ALLOWED_TOOLS_REV);
  assert.equal(t.audits.find((x) => x.action === 'gateway.key.reconcile')?.detail?.cause, 'stale-allowed-tools-stamp');
});

// Rev 4 (23 Nov 2026): a system key allows only the roles its agents run on, no longer all three. A rev-3 key holding
// all three is a narrowing the OS made: re-stamped automatically (the agent here is Standard → sovereign-worker only).
test('STALE STAMP (rev 3 → 4): a key holding all three roles is narrowed to the roles its agents use, automatically and audited', async () => {
  const t = setup();
  await t.build();
  assert.deepEqual(t.key().models, ['sovereign-worker'], 'a fresh build keys exactly the role the agent uses');
  const k = t.key();
  k.models = ['sovereign-strong', 'sovereign-worker', 'sovereign-embedding'];
  k.allowedToolsRev = 3;
  const r = await runKeyReconcile(t.io());
  assert.deepEqual(r.entries.map((e) => [e.kind, e.action]), [['drift', 'corrected']]);
  assert.deepEqual(t.key().models, ['sovereign-worker']);
  assert.equal(t.key().allowedToolsRev, ALLOWED_TOOLS_REV);
  assert.equal(t.audits.find((x) => x.action === 'gateway.key.reconcile')?.detail?.cause, 'stale-allowed-tools-stamp');
});

test('STALE STAMP twin: a CURRENT-revision key whose MODELS someone changed stays an alert (not overwritten)', async () => {
  const t = setup();
  await t.build();
  t.key().models = ['sovereign-worker', 'some-foreign-model'];
  const before = t.gw.updates;
  const r = await runKeyReconcile(t.io());
  assert.deepEqual(r.entries.map((e) => [e.kind, e.action]), [['drift', 'alert']]);
  assert.equal(t.gw.updates, before);
});

test('STALE STAMP twin: a CURRENT-revision key whose allowed tools someone changed stays an alert (not overwritten)', async () => {
  const t = setup();
  await t.build();
  t.key().allowedTools = ['search_knowledge'];
  const before = t.gw.updates;
  const r = await runKeyReconcile(t.io());
  assert.deepEqual(r.entries.map((e) => [e.kind, e.action]), [['drift', 'alert']]);
  assert.equal(t.gw.updates, before);
  assert.deepEqual(t.key().allowedTools, ['search_knowledge']);
});

test('STALE STAMP twin: an old stamp PLUS a hand edit to the budget stays an alert — the edit is never overwritten', async () => {
  const t = setup();
  await t.build();
  stampedByOldRelease(t.key());
  t.key().maxBudget = 500;
  const r = await runKeyReconcile(t.io());
  assert.deepEqual(r.entries.map((e) => e.action), ['alert']);
  assert.equal(t.key().maxBudget, 500);
});

test('STALE STAMP twin: a key whose metadata was replaced in the gateway UI (no allowed tools at all) stays an alert', async () => {
  const t = setup();
  await t.build();
  delete t.key().allowedTools;
  delete t.key().allowedToolsRev;
  const r = await runKeyReconcile(t.io());
  assert.deepEqual(r.entries.map((e) => e.action), ['alert']);
});
