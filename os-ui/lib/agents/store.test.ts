/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetStore,
  createSystem,
  promoteSystem,
  listSystems,
  markPendingShares,
  getSystem,
  getSystemForEdit,
  getSystemForRun,
  listFiles,
  readFile,
  writeFile,
  forkSystem,
  setSchedule,
  setLastBuild,
  setRunning,
  toggleAgent,
  archiveSystem,
  unarchiveSystem,
  deleteSystem,
  listSystemVersions,
  restoreSystemVersion,
  WHITELIST_HINT,
} from './store.ts';
import type { Principal, LastBuild } from './store.ts';

const sara = { id: 'sara', domains: ['sales'], role: 'builder' as const };
const amir = { id: 'amir', domains: ['sales'], role: 'creator' as const };
const kenji = { id: 'kenji', domains: ['finance'], role: 'builder' as const };
const admin = { id: 'arya', domains: ['sales'], role: 'admin' as const };
const creator = { id: 'cara', domains: ['sales'], role: 'creator' as const };

// Create is always Personal now — arrange Shared / Marketplace fixtures through
// the governed promotion ladder. `owner` must be Builder+ to reach Shared; an
// in-domain Admin lifts Shared → Marketplace.
function makeShared(owner: Principal, opts: { name: string; domain?: string }) {
  const s = createSystem(owner, opts);
  promoteSystem(s.id, owner);
  return s;
}
function makeMarketplace(owner: Principal, opts: { name: string; domain?: string }) {
  const s = makeShared(owner, opts);
  promoteSystem(s.id, admin);
  return s;
}

test('create → appears under Mine; whitelisted files round-trip read=write', () => {
  __resetStore();
  const sys = createSystem(sara, { name: 'My Desk', domain: 'sales' });
  const groups = listSystems(sara);
  assert.ok(groups.mine.some((s) => s.id === sys.id));

  const files = listFiles(sys.id, sara).files;
  assert.ok(files.includes('system.yaml'));
  assert.ok(files.some((f) => /agents\/.+\/AGENT\.md/.test(f)));

  const f = readFile(sys.id, sara, 'system.yaml');
  const next = f.content + '\n# edited\n';
  const saved = writeFile(sys.id, sara, { path: 'system.yaml', content: next, sha: f.sha });
  assert.notEqual(saved.sha, f.sha);
  assert.equal(readFile(sys.id, sara, 'system.yaml').content, next);
});

test('WP1 cross-route fix: the store is pinned to globalThis, and AGENT.md/MEMORY.md read back after create', () => {
  // Root cause of AGENT.md/MEMORY.md never loading: the Next App Router bundles
  // each route handler separately, so a module-scoped Map gave POST /systems and
  // GET /systems/[id]/files SEPARATE stores → the created system 404'd in the
  // files route. The fix pins state to globalThis. We can't spin two webpack
  // bundles in a unit test, but we CAN prove the record lives on the SHARED global
  // (which every bundle's module copy resolves to via the same Symbol), and that a
  // freshly created system's AGENT.md + MEMORY.md project + read back.
  __resetStore();
  const sys = createSystem(sara, { name: 'Roundtrip', domain: 'sales' });

  // The record is on the shared global — a second module instance (another route
  // bundle) resolving Symbol.for('soa.agents.store') would see exactly this Map.
  const g = globalThis as unknown as Record<symbol, { store: Map<string, unknown> } | undefined>;
  const shared = g[Symbol.for('soa.agents.store')];
  assert.ok(shared, 'agents store is pinned to globalThis');
  assert.ok(shared!.store.has(sys.id), 'created system lives on the shared global store');

  // create → readFile roundtrip: AGENT.md and MEMORY.md both load (were 404-ing).
  const files = listFiles(sys.id, sara).files;
  const agentMd = files.find((f) => f.endsWith('/AGENT.md'))!;
  const memoryMd = files.find((f) => f.endsWith('/MEMORY.md'))!;
  assert.ok(readFile(sys.id, sara, agentMd).content.length > 0, 'AGENT.md loads with content');
  assert.ok(readFile(sys.id, sara, memoryMd).content.length > 0, 'MEMORY.md loads with content');
});

test('WP4 templates: creating from a template scaffolds a tuned single-agent starter', () => {
  __resetStore();
  const sys = createSystem(sara, { name: 'Deal Review', domain: 'sales', template: 'evaluate' });
  const files = listFiles(sys.id, sara);
  // The evaluate template names its agent "evaluator" and makes it the entrypoint.
  assert.ok(files.system.agents.some((a) => a.id === 'evaluator'));
  assert.equal(files.system.entrypoint, 'evaluator');
  const agentMd = files.files.find((f) => f.endsWith('/AGENT.md'))!;
  assert.match(readFile(sys.id, sara, agentMd).content, /Evaluator/);
  // Templates are still Personal + read-only (no client-supplied broadening).
  assert.equal(sys.visibility, 'Personal');
  // A blank template still yields the default assistant.
  const blank = createSystem(sara, { name: 'Plain', domain: 'sales', template: 'blank' });
  assert.ok(getSystem(blank.id, sara).system.agents.some((a) => a.id === 'assistant'));
});

test('a stale sha is rejected (optimistic concurrency)', () => {
  __resetStore();
  const sys = createSystem(sara, { name: 'D', domain: 'sales' });
  const f = readFile(sys.id, sara, 'system.yaml');
  writeFile(sys.id, sara, { path: 'system.yaml', content: f.content + '\n#a', sha: f.sha });
  assert.throws(
    () => writeFile(sys.id, sara, { path: 'system.yaml', content: f.content + '\n#b', sha: f.sha }),
    /stale|changed/i,
  );
});

test('a non-whitelisted path is refused', () => {
  __resetStore();
  const sys = createSystem(sara, { name: 'D', domain: 'sales' });
  assert.throws(() => readFile(sys.id, sara, '../etc/passwd'), new RegExp(WHITELIST_HINT));
  assert.throws(
    () => writeFile(sys.id, sara, { path: 'secrets.env', content: 'x', sha: '' }),
    new RegExp(WHITELIST_HINT),
  );
});

test('AGENT.md is a projection of the one source (system.yaml)', () => {
  __resetStore();
  const sys = createSystem(sara, { name: 'D', domain: 'sales' });
  const agentFile = listFiles(sys.id, sara).files.find((f) => f.endsWith('/AGENT.md'))!;
  const f = readFile(sys.id, sara, agentFile);
  writeFile(sys.id, sara, { path: agentFile, content: '# New persona\nBe terse.', sha: f.sha });
  // The edit lands in system.yaml, not a separate file — single source.
  const yaml = readFile(sys.id, sara, 'system.yaml').content;
  assert.match(yaml, /Be terse\./);
});

test('grouping: Shared shows in My domain; Marketplace lists installs', () => {
  __resetStore();
  const shared = makeShared(sara, { name: 'Shared Desk', domain: 'sales' });
  createSystem(kenji, { name: 'Fin Desk', domain: 'finance' });
  // amir (sales) sees sara's Shared system in "My domain", not "Mine".
  const g = listSystems(amir);
  assert.ok(g.domain.some((s) => s.id === shared.id));
  assert.ok(!g.mine.some((s) => s.id === shared.id));
  // kenji (finance) does NOT see the sales Shared system.
  assert.ok(!listSystems(kenji).domain.some((s) => s.id === shared.id));
});

test('fork-to-own creates an independent copy owned by the installer (Builder)', () => {
  __resetStore();
  const market = makeMarketplace(sara, { name: 'Research Desk', domain: 'sales' });
  const fork = forkSystem(market.id, kenji); // kenji is a Builder
  assert.notEqual(fork.id, market.id);
  assert.equal(fork.owner, 'kenji');
  assert.equal(fork.visibility, 'Personal');
  assert.equal(fork.origin, 'forked');
  // Editing the fork does not touch the marketplace original.
  const f = readFile(fork.id, kenji, 'system.yaml');
  writeFile(fork.id, kenji, { path: 'system.yaml', content: f.content + '\n#mine', sha: f.sha });
  assert.notEqual(readFile(market.id, sara, 'system.yaml').content, readFile(fork.id, kenji, 'system.yaml').content);
});

test('SECURITY: installing a Marketplace agent template is Builder+ (no User/Creator fork)', () => {
  __resetStore();
  const market = makeMarketplace(sara, { name: 'Public Kit', domain: 'sales' });
  // A User (participant) and a Creator have no Marketplace install surface.
  assert.throws(() => forkSystem(market.id, amir), /Builder or Admin/i);
  assert.throws(() => forkSystem(market.id, creator), /Builder or Admin/i);
  // Builder and Admin may install.
  assert.equal(forkSystem(market.id, kenji).origin, 'forked');
  assert.equal(forkSystem(market.id, admin).origin, 'forked');
});

test('Run pre-auth: a Marketplace viewer can view but is denied edit-scope (no side effects)', () => {
  // Finding #1 — Run must authorize at EDIT level before any side effect. The
  // route now reads the system through getSystemForEdit, so a mere viewer is
  // rejected (403) BEFORE runSystem can trace / enqueue approvals.
  __resetStore();
  const market = makeMarketplace(sara, { name: 'Pub', domain: 'sales' });
  // amir (participant) can VIEW a Marketplace system...
  assert.ok(getSystem(market.id, amir));
  // ...but cannot acquire the edit-scoped view the Run/Build/Probe routes require.
  assert.throws(() => getSystemForEdit(market.id, amir), /not permitted to edit/i);
  // The owner can.
  assert.ok(getSystemForEdit(market.id, sara));
});

test('Probe pre-auth: a Shared in-domain viewer is denied edit-scope; an in-domain admin is allowed', () => {
  // Finding #4 — Probe enqueues Governance approvals, so it must authorize at
  // edit level. A Shared-system viewer (can view, cannot edit) is rejected,
  // while an in-domain admin is allowed (admin bypass).
  __resetStore();
  const shared = makeShared(sara, { name: 'Triage', domain: 'sales' });
  assert.ok(getSystem(shared.id, amir)); // amir can view (Shared, in-domain)
  assert.throws(() => getSystemForEdit(shared.id, amir), /not permitted to edit/i);
  assert.ok(getSystemForEdit(shared.id, admin)); // in-domain admin may edit
});

test("an owner's own Marketplace system lists under Mine only (no double-list)", () => {
  // Finding #6 — listSystems must use else-if for Marketplace so an owner's own
  // published system is not listed twice (Mine + Marketplace).
  __resetStore();
  const m = makeMarketplace(sara, { name: 'Pubbed', domain: 'sales' });
  const g = listSystems(sara);
  assert.ok(g.mine.some((s) => s.id === m.id), 'appears in Mine');
  assert.ok(!g.marketplace.some((s) => s.id === m.id), 'not double-listed in Marketplace');
  // A different user still discovers it in the Marketplace.
  assert.ok(listSystems(amir).marketplace.some((s) => s.id === m.id));
});

test('SECURITY: create is always Personal — client cannot self-publish', () => {
  __resetStore();
  // Even if a caller tries, createSystem no longer accepts a visibility; the
  // record lands Personal and is invisible to other users.
  const sys = createSystem(creator, { name: 'Sneaky', domain: 'sales' });
  assert.equal(sys.visibility, 'Personal');
  assert.ok(!listSystems(amir).marketplace.some((s) => s.id === sys.id));
  assert.ok(!listSystems(amir).domain.some((s) => s.id === sys.id));
});

test('SECURITY: a creator/participant cannot promote a system (Shared needs Builder+)', () => {
  __resetStore();
  const sys = createSystem(creator, { name: 'Mine', domain: 'sales' });
  assert.throws(() => promoteSystem(sys.id, creator), /Builder or Admin/i);
  assert.equal(getSystem(sys.id, creator).visibility, 'Personal');

  const pSys = createSystem(amir, { name: 'Also mine', domain: 'sales' });
  assert.throws(() => promoteSystem(pSys.id, amir), /Builder or Admin/i);
});

test('SECURITY: Personal→Shared is Builder+; Shared→Marketplace is Admin-only', () => {
  __resetStore();
  const sys = createSystem(sara, { name: 'Ladder', domain: 'sales' }); // sara = builder, owner
  // Builder lifts Personal → Shared.
  assert.equal(promoteSystem(sys.id, sara).visibility, 'Shared');
  // Builder may NOT lift Shared → Marketplace.
  assert.throws(() => promoteSystem(sys.id, sara), /Admin/i);
  assert.equal(getSystem(sys.id, sara).visibility, 'Shared');
  // In-domain Admin may.
  assert.equal(promoteSystem(sys.id, admin).visibility, 'Marketplace');
  // Already-Marketplace is rejected.
  assert.throws(() => promoteSystem(sys.id, admin), /already published/i);
});

test('SECURITY: an installed (forked) system cannot be re-published', () => {
  __resetStore();
  const market = makeMarketplace(sara, { name: 'Kit', domain: 'sales' });
  const mine = forkSystem(market.id, kenji); // kenji installs into finance
  assert.equal(mine.visibility, 'Personal');
  assert.throws(() => promoteSystem(mine.id, kenji), /forked/i);
});

// ---------------------------------------------------------------- run-scope --
// A domain-Shared system must be RUNNABLE by any Creator+ in its domain WITHOUT
// the right to edit/rebuild it (the "consume a shared agent" path — a participant
// runs the domain's ready-made Campaign Evaluation Agent but can never mutate it).
// Run is a distinct scope from edit: getSystemForRun allows it; getSystemForEdit
// (used by file writes + Build) still rejects the same Creator.
test('RUN-SCOPE: a Creator in-domain may RUN a Shared system but cannot edit/write it', () => {
  __resetStore();
  const shared = makeShared(sara, { name: 'Campaign Eval', domain: 'sales' });
  // cara (creator, sales) acquires the run-scoped view...
  assert.ok(getSystemForRun(shared.id, creator));
  // ...but NOT the edit-scoped view the Build route requires...
  assert.throws(() => getSystemForEdit(shared.id, creator), /not permitted to edit/i);
  // ...and a file WRITE is still denied at edit scope (read/view is fine).
  const f = readFile(shared.id, creator, 'system.yaml');
  assert.throws(
    () => writeFile(shared.id, creator, { path: 'system.yaml', content: f.content + '\n#x', sha: f.sha }),
    /not permitted to edit/i,
  );
});

test('RUN-SCOPE: a Creator OUTSIDE the domain is denied run', () => {
  __resetStore();
  const shared = makeShared(sara, { name: 'Campaign Eval', domain: 'sales' });
  const outsider: Principal = { id: 'fin-creator', domains: ['finance'], role: 'creator' };
  assert.throws(() => getSystemForRun(shared.id, outsider), /not permitted to run/i);
});

test('CAPABILITY: an Agentic Leader in-domain builds+runs OWN systems, RUNS a Shared one, but cannot promote', () => {
  __resetStore();
  const shared = makeShared(sara, { name: 'Campaign Eval', domain: 'sales' });
  // amir = creator (base role) in sales: VIEW + RUN the domain-Shared system.
  assert.ok(getSystem(shared.id, amir));
  assert.ok(getSystemForRun(shared.id, amir));
  // Builds + runs their OWN system.
  const own = createSystem(amir, { name: 'Amir Desk', domain: 'sales' });
  assert.ok(getSystemForRun(own.id, amir));
  // But the base role can never promote to Shared (needs Builder+).
  assert.throws(() => promoteSystem(own.id, amir), /Builder or Admin/i);
});

test('RUN-SCOPE: owner + in-domain admin unchanged; a Personal system stays owner-only', () => {
  __resetStore();
  const personal = createSystem(sara, { name: 'Sara Desk', domain: 'sales' });
  assert.ok(getSystemForRun(personal.id, sara)); // owner runs their own
  assert.ok(getSystemForRun(personal.id, admin)); // in-domain admin (edit ⇒ run)
  // A Creator cannot run someone else's PERSONAL system (not shared).
  assert.throws(() => getSystemForRun(personal.id, creator), /not permitted to run/i);
  const shared = makeShared(sara, { name: 'Shared', domain: 'sales' });
  assert.ok(getSystemForRun(shared.id, admin));
});

test('schedule persists and an agent toggle is recorded', () => {
  __resetStore();
  const sys = createSystem(sara, { name: 'D', domain: 'sales' });
  setSchedule(sys.id, sara, { kind: 'cron', cron: '0 9 * * 1' });
  assert.equal(getSystem(sys.id, sara).schedule?.cron, '0 9 * * 1');
  const entry = getSystem(sys.id, sara).system.agents[0].id;
  toggleAgent(sys.id, sara, entry, false);
  assert.ok(getSystem(sys.id, sara).disabledAgents.includes(entry));
});

test('markPendingShares: a filed Personal→Shared promotion badges the owned Personal system only', () => {
  __resetStore();
  const a = createSystem(creator, { name: 'Pending one', domain: 'sales' }); // Personal, filed
  const b = createSystem(creator, { name: 'Not filed', domain: 'sales' });     // Personal, no request
  const groups = listSystems(creator);
  const marked = markPendingShares(groups, new Set([a.id]));
  const find = (id: string) => marked.mine.find((s) => s.id === id)!;
  assert.equal(find(a.id).pendingShare, true, 'the filed Personal system is badged');
  assert.equal(find(b.id).pendingShare, undefined, 'an unfiled system is not badged');
  // Non-mutating + a no-op when nothing is pending.
  assert.equal(groups.mine.find((s) => s.id === a.id)!.pendingShare, undefined);
  assert.equal(markPendingShares(groups, new Set()), groups);
});

test('markPendingShares: never badges an already-Shared system even if an id lingers', () => {
  __resetStore();
  const shared = makeShared(sara, { name: 'Already shared', domain: 'sales' });
  const marked = markPendingShares(listSystems(sara), new Set([shared.id]));
  assert.equal(marked.mine.find((s) => s.id === shared.id)!.pendingShare, undefined);
});

test('BUILDER-GATE: a creator saving a Write-bounded artifact grant is rejected server-side', () => {
  __resetStore();
  // A creator owns + edits their own system. Craft a payload that tries to grant
  // the agent DIRECT write (Write-bounded) on a data product — the UI can't send
  // this, but a hand-crafted PUT could. The save chokepoint must reject it.
  const sys = createSystem(creator, { name: 'Sneaky', domain: 'sales' });
  const f = readFile(sys.id, creator, 'system.yaml');
  const escalated = f.content.replace(
    /grants:\n([\s\S]*?)\n(routing|agents):/,
    'grants:\n  data:\n    - id: sales.orders\n      capability: Write-bounded\n  knowledge: []\n  tools: []\n  connections: []\n$2:',
  );
  assert.notEqual(escalated, f.content); // sanity: the splice happened
  assert.throws(
    () => writeFile(sys.id, creator, { path: 'system.yaml', content: escalated, sha: f.sha }),
    /builder-only/i,
  );

  // A Write-approval grant (held for a human) is allowed at any role.
  const proposed = escalated.replace('Write-bounded', 'Write-approval');
  const saved = writeFile(sys.id, creator, { path: 'system.yaml', content: proposed, sha: f.sha });
  assert.ok(saved.sha);
  assert.equal(getSystem(sys.id, creator).system.grants.data[0].capability, 'Write-approval');
});

test('BUILDER-GATE: a builder MAY save a Write-bounded (direct) artifact grant', () => {
  __resetStore();
  const sys = createSystem(sara, { name: 'Direct', domain: 'sales' });
  const f = readFile(sys.id, sara, 'system.yaml');
  const direct = f.content.replace(
    /grants:\n([\s\S]*?)\n(routing|agents):/,
    'grants:\n  data:\n    - id: sales.orders\n      capability: Write-bounded\n  knowledge: []\n  tools: []\n  connections: []\n$2:',
  );
  assert.notEqual(direct, f.content);
  const saved = writeFile(sys.id, sara, { path: 'system.yaml', content: direct, sha: f.sha });
  assert.ok(saved.sha);
  assert.equal(getSystem(sys.id, sara).system.grants.data[0].capability, 'Write-bounded');
});

test('N1: a pre-existing Write-bounded grant (set while builder) does NOT block the same owner after a downgrade to creator', () => {
  __resetStore();
  // Same owner id 'cara': first a builder (sets the direct-write grant), later
  // downgraded to creator. The stored system now carries a Write-bounded grant.
  const caraBuilder = { id: 'cara', domains: ['sales'], role: 'builder' as const };
  const sys = createSystem(caraBuilder, { name: 'Owned', domain: 'sales' });
  const f0 = readFile(sys.id, caraBuilder, 'system.yaml');
  const withDirect = f0.content.replace(
    /grants:\n([\s\S]*?)\n(routing|agents):/,
    'grants:\n  data:\n    - id: sales.orders\n      capability: Write-bounded\n  knowledge: []\n  tools: []\n  connections: []\n$2:',
  );
  assert.notEqual(withDirect, f0.content);
  writeFile(sys.id, caraBuilder, { path: 'system.yaml', content: withDirect, sha: f0.sha });

  // Now the SAME owner, downgraded to creator, makes an UNRELATED edit (append a
  // comment), carrying the pre-existing direct-write grant forward untouched —
  // must NOT be rejected (N1).
  const f1 = readFile(sys.id, creator, 'system.yaml');
  const edited = f1.content + '\n# creator note\n';
  assert.doesNotThrow(() => writeFile(sys.id, creator, { path: 'system.yaml', content: edited, sha: f1.sha }));
  assert.equal(getSystem(sys.id, creator).system.grants.data[0].capability, 'Write-bounded');

  // But the creator INTRODUCING a second direct-write grant is still rejected.
  const f2 = readFile(sys.id, creator, 'system.yaml');
  const escalated = f2.content.replace(
    'capability: Write-bounded',
    'capability: Write-bounded\n    - id: sales.customers\n      capability: Write-bounded',
  );
  assert.throws(
    () => writeFile(sys.id, creator, { path: 'system.yaml', content: escalated, sha: f2.sha }),
    /builder-only/i,
  );
});

test('lastBuild round-trips: persisted build result loads on getSystem and is absent before first build', () => {
  __resetStore();
  const sys = createSystem(sara, { name: 'BuildPersist', domain: 'sales' });

  // A fresh system has no lastBuild.
  assert.equal(getSystem(sys.id, sara).lastBuild, undefined);

  const build: LastBuild = {
    ok: true,
    at: Date.now(),
    rows: [
      { tool: 'langgraph', applied: true, verified: true, status: 'ok', detail: 'compiled' },
      { tool: 'opa', applied: true, verified: true, status: 'ok', detail: 'grants registered' },
    ],
  };
  setLastBuild(sys.id, sara, build);

  // The record now carries the build result.
  const view = getSystem(sys.id, sara);
  assert.ok(view.lastBuild, 'lastBuild is present after setLastBuild');
  assert.equal(view.lastBuild!.ok, true);
  assert.equal(view.lastBuild!.rows.length, 2);
  assert.equal(view.lastBuild!.rows[0].tool, 'langgraph');
  assert.equal(view.lastBuild!.rows[1].tool, 'opa');
  assert.ok(view.lastBuild!.at > 0, 'at timestamp is set');

  // A failing build result also round-trips correctly.
  const failBuild: LastBuild = {
    ok: false,
    at: Date.now(),
    rows: [
      { tool: 'langgraph', applied: false, verified: false, status: 'fail', detail: 'bad yaml', error: 'SyntaxError' },
    ],
  };
  setLastBuild(sys.id, sara, failBuild);
  const view2 = getSystem(sys.id, sara);
  assert.equal(view2.lastBuild!.ok, false);
  assert.equal(view2.lastBuild!.rows[0].error, 'SyntaxError');

  // A non-editor cannot overwrite the build result.
  assert.throws(() => setLastBuild(sys.id, amir, build), /not permitted to edit/i);
});

// ------------------------------------------------ archive / delete / versions --

test('writeFile snapshots the prior source; restore reverts + is itself versioned', () => {
  __resetStore();
  const sys = createSystem(sara, { name: 'Versioned', domain: 'sales' });
  const v0 = readFile(sys.id, sara, 'system.yaml');
  assert.equal(listSystemVersions(sys.id, sara).length, 0, 'no history before first edit');

  // First edit → one prior version captured.
  const edit1 = v0.content + '\n# edit-1\n';
  const s1 = writeFile(sys.id, sara, { path: 'system.yaml', content: edit1, sha: v0.sha });
  // Second edit → two prior versions.
  const edit2 = edit1 + '# edit-2\n';
  writeFile(sys.id, sara, { path: 'system.yaml', content: edit2, sha: s1.sha });

  const history = listSystemVersions(sys.id, sara);
  assert.equal(history.length, 2);
  assert.equal(history[0].version, 2, 'newest first');
  assert.equal(history[0].author, 'sara');
  assert.equal(history[1].version, 1, 'oldest last');

  // A no-op save does NOT churn a new version.
  writeFile(sys.id, sara, { path: 'system.yaml', content: edit2, sha: readFile(sys.id, sara, 'system.yaml').sha });
  assert.equal(listSystemVersions(sys.id, sara).length, 2);

  // Restore v1 (the original) → live yaml reverts AND the pre-restore state is
  // snapshotted as v3, so restore is auditable + reversible.
  restoreSystemVersion(sys.id, sara, 1);
  assert.equal(readFile(sys.id, sara, 'system.yaml').content, v0.content);
  const after = listSystemVersions(sys.id, sara);
  assert.equal(after.length, 3);
  assert.equal(after[0].version, 3);
  assert.match(after[0].summary, /restore of v1/);

  // Restoring an unknown version 404s.
  assert.throws(() => restoreSystemVersion(sys.id, sara, 99), /not found/i);
});

test('archive hides + stops the system; unarchive restores it', () => {
  __resetStore();
  const sys = createSystem(sara, { name: 'Archivable', domain: 'sales' });
  setRunning(sys.id, sara, true);
  assert.equal(getSystem(sys.id, sara).running, true);

  archiveSystem(sys.id, sara);
  const archived = getSystem(sys.id, sara);
  assert.equal(archived.archived, true);
  assert.equal(archived.running, false, 'archiving stops the system');
  // Hidden from the default working list, visible with includeArchived.
  assert.ok(!listSystems(sara).mine.some((s) => s.id === sys.id));
  assert.ok(listSystems(sara, { includeArchived: true }).mine.some((s) => s.id === sys.id));

  unarchiveSystem(sys.id, sara);
  assert.equal(getSystem(sys.id, sara).archived, false);
  assert.ok(listSystems(sara).mine.some((s) => s.id === sys.id));
});

test('delete removes the system permanently + purges its history', () => {
  __resetStore();
  const sys = createSystem(sara, { name: 'Deletable', domain: 'sales' });
  const v0 = readFile(sys.id, sara, 'system.yaml');
  writeFile(sys.id, sara, { path: 'system.yaml', content: v0.content + '\n# e\n', sha: v0.sha });
  assert.equal(listSystemVersions(sys.id, sara).length, 1);

  deleteSystem(sys.id, sara);
  assert.throws(() => getSystem(sys.id, sara), /not found/i);
  assert.ok(!listSystems(sara, { includeArchived: true }).mine.some((s) => s.id === sys.id));

  // A fresh system reusing nothing has no leaked history (purge worked).
  const sys2 = createSystem(sara, { name: 'Fresh', domain: 'sales' });
  assert.equal(listSystemVersions(sys2.id, sara).length, 0);
});

test('archive / delete / restore obey edit authz (a viewer is rejected 403)', () => {
  __resetStore();
  // Shared system in sales; amir (creator, same domain) can VIEW but not EDIT.
  const sys = makeShared(sara, { name: 'Governed', domain: 'sales' });
  const v0 = readFile(sys.id, sara, 'system.yaml');
  writeFile(sys.id, sara, { path: 'system.yaml', content: v0.content + '\n# e\n', sha: v0.sha });

  // Viewer may READ history but not mutate.
  assert.doesNotThrow(() => listSystemVersions(sys.id, amir));
  assert.throws(() => archiveSystem(sys.id, amir), /not permitted to edit/i);
  assert.throws(() => deleteSystem(sys.id, amir), /not permitted to edit/i);
  assert.throws(() => restoreSystemVersion(sys.id, amir, 1), /not permitted to edit/i);

  // A same-domain Admin (builder+ over the domain) may archive it.
  assert.doesNotThrow(() => archiveSystem(sys.id, admin));
});
