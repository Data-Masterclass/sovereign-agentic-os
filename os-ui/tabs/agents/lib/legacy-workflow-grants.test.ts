/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Saved agent systems survive the workflow/knowledge split
 * USER STORY: As the owner of an agent system that granted a workflow under "knowledge" and used
 *             `author_knowledge`, I want it to keep running after the upgrade, with its grants and
 *             tools named correctly, and I want the stored rewrite to be safe to run twice.
 * ARCHITECTURE:
 *   - Pure rule (`migrateLegacyWorkflowGrants`) → read path (`parseSystem`) → stored rewrite
 *     (`migrateStoredWorkflowGrants`, with a dry run) → boot pass (`runWorkflowGrantMigrationPass`).
 *   - Every layer is tested for IDEMPOTENCE, and for never granting anything the system did not have.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { migrateLegacyWorkflowGrants, legacyWorkflowFindings } from '@tabs/agents/lib/legacy-workflow-grants';
import { parseSystem, serializeSystem } from '@tabs/agents/lib/system-schema';
import { createSystem, migrateStoredWorkflowGrants, __recordFor, __resetStore } from '@tabs/agents/lib/store';
import { runWorkflowGrantMigrationPass, migrationModeFromEnv } from '@tabs/agents/lib/workflow-grant-migration';

const cara = { id: 'cara', domains: ['sales'], role: 'creator' as const };

const LEGACY_YAML = `version: '1'
system:
  name: Legacy team
  domain: sales
  visibility: Personal
entrypoint: writer
grants:
  data: []
  knowledge:
    - { id: wf_refunds, capability: Write-approval }
    - { id: pk_notes, capability: Read }
    - id: ''
      capability: Read
      folder: { path: /results, scope: personal }
  metrics: []
  tools: [search_knowledge, list_knowledge, get_knowledge, author_knowledge, index_knowledge, save_knowledge_note]
  connections: []
agents:
  - id: writer
    role: writes
    tools: [get_knowledge, author_knowledge]
`;

function markHydrated(): void {
  const g = globalThis as unknown as Record<symbol, { hydratedAt?: number } | undefined>;
  const st = g[Symbol.for('soa.agents.store')];
  if (st) st.hydratedAt = Date.now();
}

beforeEach(() => {
  __resetStore();
  const g = globalThis as unknown as Record<symbol, { hydratedAt?: number; hydrateFailedAt?: number } | undefined>;
  const st = g[Symbol.for('soa.agents.store')];
  if (st) {
    delete st.hydratedAt;
    delete st.hydrateFailedAt;
  }
});

// ─── the pure rule ────────────────────────────────────────────────────────────────────────

test('wf_ ids move from knowledge to workflows with their capability; notes, folder grants and the rest stay', () => {
  const r = migrateLegacyWorkflowGrants({
    knowledge: [
      { id: 'wf_refunds', capability: 'Write-approval' },
      { id: 'pk_notes', capability: 'Read' },
      { id: '', capability: 'Read', folder: { path: '/results', scope: 'personal' } },
    ],
    tools: ['author_knowledge', 'list_knowledge', 'save_knowledge_note'],
  });
  assert.deepEqual(r.workflows, [{ id: 'wf_refunds', capability: 'Write-approval' }]);
  assert.deepEqual(r.knowledge.map((g) => g.id), ['pk_notes', '']);
  assert.ok(r.changed && r.notes.length >= 2);
});

test('the four write tools are renamed; list_/get_knowledge gain the workflow read tools only when a workflow is in play', () => {
  const r = migrateLegacyWorkflowGrants({
    knowledge: [{ id: 'wf_a', capability: 'Read' }],
    tools: ['search_knowledge', 'list_knowledge', 'get_knowledge', 'author_knowledge', 'index_knowledge', 'publish_knowledge', 'retire_knowledge'],
  });
  assert.deepEqual(r.tools, ['search_knowledge', 'list_knowledge', 'get_knowledge', 'author_workflow', 'index_workflow', 'publish_workflow', 'retire_workflow', 'list_workflows', 'get_workflow']);
  // A pure NOTES system — no workflow grant, no old workflow tool — is untouched: nothing is added.
  const notes = migrateLegacyWorkflowGrants({ knowledge: [{ id: 'pk_a', capability: 'Read' }], tools: ['search_knowledge', 'list_knowledge', 'get_knowledge', 'save_knowledge_note'] });
  assert.equal(notes.changed, false);
  assert.deepEqual(notes.tools, ['search_knowledge', 'list_knowledge', 'get_knowledge', 'save_knowledge_note']);
  assert.deepEqual(notes.workflows, []);
});

test('NEGATIVE TWIN: the rule never grants anything new — a system without a read tool gets none, and a note-only write system gets no workflow tool', () => {
  const r = migrateLegacyWorkflowGrants({ knowledge: [{ id: 'wf_a', capability: 'Read' }], tools: ['search_knowledge'] });
  assert.deepEqual(r.tools, ['search_knowledge'], 'search_knowledge alone gains no list/get tool');
  const noteWriter = migrateLegacyWorkflowGrants({ knowledge: [{ id: 'pk_a', capability: 'Write-bounded' }], tools: ['save_knowledge_note'] });
  assert.deepEqual(noteWriter.tools, ['save_knowledge_note']);
  assert.ok(!noteWriter.tools.some((t) => /workflow/.test(t)));
});

test('IDEMPOTENT: applying the rule to its own output changes nothing (same arrays back)', () => {
  const once = migrateLegacyWorkflowGrants({
    knowledge: [{ id: 'wf_a', capability: 'Read' }, { id: 'pk_b', capability: 'Read' }],
    tools: ['get_knowledge', 'author_knowledge'],
  });
  const twice = migrateLegacyWorkflowGrants({ knowledge: once.knowledge, workflows: once.workflows, tools: once.tools });
  assert.equal(twice.changed, false);
  assert.equal(twice.knowledge, once.knowledge);
  assert.equal(twice.workflows, once.workflows);
  assert.equal(twice.tools, once.tools);
  // A workflow already under `workflows` is not duplicated by a stale copy under knowledge.
  const dup = migrateLegacyWorkflowGrants({ knowledge: [{ id: 'wf_a', capability: 'Read' }], workflows: [{ id: 'wf_a', capability: 'Read' }], tools: [] });
  assert.deepEqual(dup.workflows, [{ id: 'wf_a', capability: 'Read' }]);
});

// ─── the read path ────────────────────────────────────────────────────────────────────────

test('parseSystem upgrades a legacy system.yaml on read — the system keeps running unchanged', () => {
  const sys = parseSystem(LEGACY_YAML);
  assert.deepEqual(sys.grants.workflows, [{ id: 'wf_refunds', capability: 'Write-approval' }]);
  assert.ok(!sys.grants.knowledge.some((g) => g.id.startsWith('wf_')));
  assert.ok(sys.grants.tools.includes('author_workflow') && sys.grants.tools.includes('index_workflow'));
  assert.ok(sys.grants.tools.includes('list_workflows') && sys.grants.tools.includes('get_workflow'));
  assert.ok(!sys.grants.tools.includes('author_knowledge'));
  assert.ok(sys.grants.tools.includes('save_knowledge_note'), 'the note write is kept');
  assert.deepEqual(sys.agents[0].tools, ['get_knowledge', 'author_workflow', 'get_workflow'], 'an agent’s own narrowed list is upgraded too');
});

test('a re-serialised migrated system round-trips to itself (no drift on a second save)', () => {
  const a = serializeSystem(parseSystem(LEGACY_YAML));
  const b = serializeSystem(parseSystem(a));
  assert.equal(b, a);
  assert.match(a, /workflows:\n\s+- id: wf_refunds/);
  assert.equal(legacyWorkflowFindings(a).length, 0, 'the rewritten text has nothing left to migrate');
});

test('byte-stability: a system with no workflow grant serialises with NO `workflows` key', () => {
  const plain = serializeSystem(parseSystem(`system:\n  name: Plain\n  domain: sales\nagents: []\ngrants:\n  knowledge:\n    - { id: pk_x, capability: Read }\n  tools: [search_knowledge]\n`));
  assert.doesNotMatch(plain, /workflows/);
});

// ─── the stored rewrite ───────────────────────────────────────────────────────────────────

test('stored migration: DRY RUN reports and writes nothing; APPLY rewrites; a SECOND apply finds nothing', () => {
  const legacy = createSystem(cara, { name: 'Legacy team', yaml: LEGACY_YAML });
  const plain = createSystem(cara, { name: 'Notes only', yaml: `system:\n  name: Notes only\n  domain: sales\nagents: []\ngrants:\n  knowledge:\n    - { id: pk_x, capability: Read }\n  tools: [search_knowledge, save_knowledge_note]\n` });
  const plainBefore = __recordFor(plain.id)!.yaml;
  assert.equal(migrateStoredWorkflowGrants({ dryRun: true }), null, 'an unhydrated registry is never migrated (it could be empty by accident)');
  markHydrated();

  const before = __recordFor(legacy.id)!.yaml;
  const dry = migrateStoredWorkflowGrants({ dryRun: true })!;
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.changed.map((c) => c.id), [legacy.id]);
  assert.ok(dry.changed[0].findings.some((f) => /wf_refunds/.test(f)) && dry.changed[0].findings.some((f) => /author_knowledge/.test(f)));
  assert.equal(__recordFor(legacy.id)!.yaml, before, 'a dry run writes nothing');

  const applied = migrateStoredWorkflowGrants({ actorId: 'migration' })!;
  assert.deepEqual(applied.changed.map((c) => c.id), [legacy.id]);
  assert.equal(applied.failed.length, 0);
  const after = __recordFor(legacy.id)!.yaml;
  assert.notEqual(after, before);
  assert.equal(legacyWorkflowFindings(after).length, 0);
  assert.equal(__recordFor(plain.id)!.yaml, plainBefore, 'a system with nothing to migrate is not touched at all');

  const again = migrateStoredWorkflowGrants()!;
  assert.deepEqual(again.changed, [], 'idempotent: the second pass changes nothing');
  assert.equal(__recordFor(legacy.id)!.yaml, after, 'and does not rewrite the text');
  assert.equal(parseSystem(after).grants.workflows[0].capability, 'Write-approval', 'the capability survived the rewrite');
});

// ─── the boot pass ────────────────────────────────────────────────────────────────────────

test('boot pass: mode comes from OS_WORKFLOW_GRANT_MIGRATION; dry-run logs "WOULD rewrite" and writes nothing; off does nothing', async () => {
  assert.equal(migrationModeFromEnv(undefined), 'apply');
  assert.equal(migrationModeFromEnv('dry-run'), 'dry-run');
  assert.equal(migrationModeFromEnv('OFF'), 'off');
  assert.equal(migrationModeFromEnv('nonsense'), 'apply');

  const legacy = createSystem(cara, { name: 'Legacy team', yaml: LEGACY_YAML });
  markHydrated();
  const lines: string[] = [];
  const io = { ensureHydrated: async () => {}, migrate: (o: { dryRun: boolean }) => migrateStoredWorkflowGrants(o), log: (l: string) => lines.push(l) };
  const before = __recordFor(legacy.id)!.yaml;

  assert.equal(await runWorkflowGrantMigrationPass('off', io), true);
  assert.equal(lines.length, 0);
  assert.equal(await runWorkflowGrantMigrationPass('dry-run', io), true);
  assert.ok(lines.some((l) => /WOULD rewrite/.test(l) && l.includes(legacy.id)));
  assert.equal(__recordFor(legacy.id)!.yaml, before);

  lines.length = 0;
  assert.equal(await runWorkflowGrantMigrationPass('apply', io), true);
  assert.ok(lines.some((l) => / rewrote system /.test(l)));
  lines.length = 0;
  assert.equal(await runWorkflowGrantMigrationPass('apply', io), true);
  assert.ok(!lines.some((l) => /rewrote/.test(l)), 'the second boot rewrites nothing');
});

test('boot pass: an unhydrated registry is reported as not done (it retries), never as "nothing to do"', async () => {
  createSystem(cara, { name: 'Legacy team', yaml: LEGACY_YAML });
  const io = { ensureHydrated: async () => {}, migrate: (o: { dryRun: boolean }) => migrateStoredWorkflowGrants(o), log: () => {} };
  assert.equal(await runWorkflowGrantMigrationPass('apply', io), false);
});
