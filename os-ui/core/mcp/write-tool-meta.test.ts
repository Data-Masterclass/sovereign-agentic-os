/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ALL_WRITE_TOOLS } from '@core/mcp/write-tools';
import { ALL_MCP_TOOLS, listToolsForRole } from '@core/mcp/server';
import { WRITE_TOOL_TABS, WRITE_TOOL_NAMES, AGENT_FORBIDDEN_TOOLS, agentForbiddenReason } from '@core/mcp/write-tool-meta';
import { READ_TOOLS, UNCLASSIFIED_BACKLOG } from '@core/mcp/tool-classes';

/**
 * The write tools that do NOT live in `ALL_WRITE_TOOLS`: the PLATFORM-MCP surface
 * (`tabs/software/lib/platform-mcp.ts`, registered as the `platform` experimental bundle) declares
 * its own `write: true` tools. The hold gate reads WRITE_TOOL_TABS, so a platform write missing
 * from it is NEVER held — which is exactly the gap the night-2 app-builder stream found for
 * `commit` (review H-1). They are listed LITERALLY here because a core test must not import a tab
 * (CORE-INDEPENDENCE); `tabs/software/lib/builder/dispatch.test.ts` asserts this literal still
 * matches the real `PLATFORM_MCP_TOOLS` write flags, so the two halves cannot drift silently.
 *
 * NIGHT-2 MERGE: `push_app_files` joined `commit` here. Stream S shipped it as a platform write
 * (it commits an app's source tree), and H's tripwire caught that it was unclassified — the same
 * unheld-write gap H-1 closed for `commit`. The shipped Software Delivery Team grants `commit` and
 * not `push_app_files`, so classifying it moved no golden.
 *
 * 2026-11-19: `set_app_spec` joined them — the FOURTH time a tool in the catalog turned out not
 * to be held-eligible. It PUBLISHES (it writes the live served surface and snapshots a version),
 * so an agent granted it under ANY preset — `read-only` included — could put an app live with no
 * hold. No golden moved: nothing grants it.
 *
 * Then `design_software` — the FIFTH, and the unclassified TWIN of `set_app_design`. Both land in
 * the same governed write (`patchAppDesign`); only the tab's own tool was classified, so the hold
 * posture of one write depended on which of its two names the agent used. No golden moved either.
 *
 * 2026-11-19, later the same day: the REMAINING ELEVEN joined them, which closes the list — every
 * `write: true` tool on the platform-MCP surface is now classified, and the ratchet in
 * `tabs/software/lib/builder/dispatch.test.ts` pins the unclassified remainder at ZERO. They carry
 * three different postures (the owner's decision; the table and the reasons are in
 * `write-tool-meta.ts` and `tabs/agents/lib/build/hold.ts`, the per-tool tests in
 * `tabs/agents/lib/build/os-tools.test.ts`):
 *   - `decide_deploy`, `promote`            — closed to agent runs outright (AGENT_FORBIDDEN_TOOLS);
 *   - `delete`, `archive`, `request_deploy` — held for a human under EVERY preset;
 *   - `create_software`, `use_connection`, `use_data`, `use_knowledge`, `use_as_data`,
 *     `start_preview`                       — the runner's own My-scope work (read-only holds).
 * One frozen golden's ENGINE-side assertion moved (`software-team`: the deployer now parks on
 * `request_deploy`); the fixture file itself is untouched. See `engine/parity.test.ts`.
 */
const PLATFORM_WRITE_TOOLS: Readonly<Record<string, string>> = {
  commit: 'software',
  push_app_files: 'software',
  set_app_spec: 'software',
  design_software: 'software',
  create_software: 'software',
  start_preview: 'software',
  request_deploy: 'software',
  decide_deploy: 'software',
  promote: 'software',
  use_connection: 'software',
  use_data: 'software',
  use_knowledge: 'software',
  use_as_data: 'software',
  archive: 'software',
  delete: 'software',
};

/**
 * Writes built by a FACTORY rather than exported as a static array. `reindex_corpus`
 * (`core/mcp/reindex-tools.ts`) takes the two tab-owned re-index services as arguments, because
 * one tool must serve both corpora and neither a tab nor the kernel may import the other tab — so
 * it cannot be in `ALL_WRITE_TOOLS`, which is a barrel of static arrays. It still rewrites index
 * rows, so the hold gate has to know it is a write: listed here for the same reason `commit` is.
 */
const FACTORY_WRITE_TOOLS: Readonly<Record<string, string>> = { reindex_corpus: 'files', delete_domain: 'governance' };

/**
 * The APPROVAL verbs that live outside both `ALL_WRITE_TOOLS` and the platform surface (review
 * H2): `decide_approval` is a governance tool (`core/mcp/governance-tools.ts`) and
 * `promote_connection` sits with the connection discovery tools. Both are closed to agent runs
 * (`AGENT_FORBIDDEN_TOOLS`), and a forbidden tool must also be a classified write so the hold is
 * the second line behind the refusal — so they are classified by name, like the platform writes.
 */
const APPROVAL_WRITE_TOOLS: Readonly<Record<string, string>> = {
  decide_approval: 'governance',
  promote_connection: 'connections',
};

/**
 * THE NINE that were the "unclassified backlog" until the owner decided each one (2026-11-19).
 * None is in `ALL_WRITE_TOOLS` (the connection lifecycle tools sit with the connection discovery
 * tools, the Operating Model tools in `core/mcp/manual-tools.ts`, `request_certification` in the
 * governance tools) and `build_software` declares `write: false` on the platform surface, so —
 * like the approvals above — they are classified by name. Three postures, enforced elsewhere and
 * tested per tool in `tabs/agents/lib/build/os-tools.test.ts`:
 *   - `revoke_action_adoption`                               — closed to agent runs outright;
 *   - `retire_connection`, `request_certification`,
 *     `update_operating_manual`, `restore_operating_manual_version` — held under EVERY preset;
 *   - `create_connection`, `configure_connection`, `test_connection`, `build_software`
 *                                                            — the runner's own My-scope work.
 */
const DECIDED_BACKLOG_WRITE_TOOLS: Readonly<Record<string, string>> = {
  revoke_action_adoption: 'connections',
  retire_connection: 'connections',
  request_certification: 'governance',
  update_operating_manual: 'operating-manual',
  restore_operating_manual_version: 'operating-manual',
  create_connection: 'connections',
  configure_connection: 'connections',
  test_connection: 'connections',
  build_software: 'software',
};

test('WRITE_TOOL_TABS matches ALL_WRITE_TOOLS plus the platform-MCP, factory, approval and decided-backlog writes (names and tabs)', () => {
  const actual = {
    ...Object.fromEntries(ALL_WRITE_TOOLS.map((t) => [t.name, t.tab])),
    ...PLATFORM_WRITE_TOOLS,
    ...FACTORY_WRITE_TOOLS,
    ...APPROVAL_WRITE_TOOLS,
    ...DECIDED_BACKLOG_WRITE_TOOLS,
  };
  assert.deepEqual(WRITE_TOOL_TABS, actual);
  assert.equal(
    WRITE_TOOL_NAMES.size,
    ALL_WRITE_TOOLS.length +
      Object.keys(PLATFORM_WRITE_TOOLS).length +
      Object.keys(FACTORY_WRITE_TOOLS).length +
      Object.keys(APPROVAL_WRITE_TOOLS).length +
      Object.keys(DECIDED_BACKLOG_WRITE_TOOLS).length,
    'duplicate write tool names',
  );
});

test('the nine decided-backlog tools are classified under the tab the REGISTRY gives them', () => {
  // The literal above is hand-written; this ties it to the real registry so a retabbed or renamed
  // tool cannot leave a stale row behind.
  const byName = new Map(ALL_MCP_TOOLS.map((t) => [t.name, t.tab as string]));
  for (const [name, tab] of Object.entries(DECIDED_BACKLOG_WRITE_TOOLS)) {
    assert.equal(byName.get(name), tab, `${name} is registered under '${byName.get(name)}'`);
    assert.ok(WRITE_TOOL_NAMES.has(name), `${name} must be visible to the hold gate`);
  }
});

test('the factory-built write is classified for the hold gate', () => {
  for (const [name, tab] of Object.entries(FACTORY_WRITE_TOOLS)) {
    assert.equal(WRITE_TOOL_TABS[name], tab, `${name} must be in the hold-gate table`);
    assert.ok(WRITE_TOOL_NAMES.has(name));
  }
});

test('every platform-MCP write listed here is actually held-eligible', () => {
  for (const [name, tab] of Object.entries(PLATFORM_WRITE_TOOLS)) {
    assert.equal(WRITE_TOOL_TABS[name], tab, `${name} must be in the hold-gate table`);
    assert.ok(WRITE_TOOL_NAMES.has(name));
  }
});

/**
 * H1 of the re-index review: being in the write catalog makes a tool HELD, not unavailable, and
 * for one of them "held" is not the posture we want — an unattended run has no business
 * re-indexing a tenant corpus. The catalog of agent-closed tools lives next to the write catalog
 * so neither agent-facing door can forget it, and every entry must ALSO be a classified write:
 * the hold is the second line of defence behind the refusal, and a tool that is closed but
 * unclassified would be unheld the moment someone removed the refusal.
 */
test('AGENT_FORBIDDEN_TOOLS: every agent-closed tool is also a classified write, and says why', () => {
  assert.ok(Object.keys(AGENT_FORBIDDEN_TOOLS).length > 0);
  for (const [name, reason] of Object.entries(AGENT_FORBIDDEN_TOOLS)) {
    assert.ok(WRITE_TOOL_NAMES.has(name), `${name} must also be in the hold-gate table`);
    assert.ok(reason.length > 40, `${name} must tell the caller WHY, and where to do it instead`);
    assert.equal(agentForbiddenReason(name), reason);
  }
  assert.equal(agentForbiddenReason('create_dataset'), null, 'an ordinary write is not closed');
  assert.equal(agentForbiddenReason(''), null);
});

test('AGENT_FORBIDDEN_TOOLS: approvals are closed to agent runs — four-eyes means two humans', () => {
  // The owner's decision (2026-11-19): an agent can NEVER execute an approval. A held approval is
  // not enough — whoever approves the hold would be approving the agent's approval, and the
  // go-live would then carry one human decision while reading as two.
  for (const name of ['decide_deploy', 'promote', 'decide_approval', 'promote_connection']) {
    const reason = agentForbiddenReason(name);
    assert.ok(reason, `${name} must be closed to agent runs`);
    assert.match(reason!, /human decision/);
    assert.match(reason!, /four-eyes/);
  }
  assert.deepEqual(Object.keys(AGENT_FORBIDDEN_TOOLS).sort(), [
    'decide_approval', 'decide_deploy', 'delete_domain', 'promote', 'promote_connection', 'reindex_corpus', 'revoke_action_adoption',
  ]);
  // Requesting is not approving: the request side stays open to agents (and is held instead).
  assert.equal(agentForbiddenReason('request_deploy'), null);
  assert.equal(agentForbiddenReason('request_promotion'), null);
});

test('AGENT_FORBIDDEN_TOOLS: revoking an action adoption is a governance decision — closed to agent runs', () => {
  // The owner's decision (2026-11-19). It is the INVERSE of an approval: a domain admin withdrawing
  // what their domain adopted. Not four-eyes (one person decides it), so the reason does not claim
  // that — it says whose decision it is and where a person takes it.
  const reason = agentForbiddenReason('revoke_action_adoption');
  assert.ok(reason, 'revoke_action_adoption must be closed to agent runs');
  assert.match(reason!, /human decision, not an agent action/);
  assert.match(reason!, /domain admin/);
  assert.match(reason!, /their own MCP session/);
  // Adopting is the other direction and is NOT closed by this change.
  assert.equal(agentForbiddenReason('adopt_entity_actions'), null);
});

test('agentForbiddenReason answers by OWN name only — never for a name inherited from Object.prototype', () => {
  // Review L1: a bare `TABLE[name]` returned `Object` for 'constructor', a function for
  // 'toString' and an object for '__proto__' — truthy, so every door that asks
  // `if (agentForbiddenReason(name))` refused them, with a "reason" that was not a string.
  for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'prototype']) {
    assert.equal(agentForbiddenReason(name), null, `${name} is not a forbidden tool`);
  }
  for (const name of Object.keys(AGENT_FORBIDDEN_TOOLS)) assert.equal(typeof agentForbiddenReason(name), 'string');
});

test('AGENT_FORBIDDEN_TOOLS: the catalog names exactly the doors that consult it — and the ones that do not', () => {
  // History: the first version of this comment claimed a door consulted the table when it did
  // not; the second said "TWO doors" and "never executed, never advertised" as if that were every
  // door, while the two interactive assistants offer the role-scoped registry and consult neither
  // table (review M1). A comment that overstates a guard is worse than none — the next reader
  // stops looking — so the scope statement is pinned in BOTH directions.
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'write-tool-meta.ts'), 'utf8');
  assert.match(src, /WHICH DOORS CONSULT THIS — exactly three/);
  assert.match(src, /`tabs\/agents\/lib\/build\/os-tools\.ts`/);
  assert.match(src, /`tabs\/agents\/lib\/build\/phase-tools\.ts`/);
  assert.match(src, /`tabs\/software\/lib\/app-tool-call\.ts`/);
  assert.match(src, /OUT OF SCOPE, on purpose/);
  assert.match(src, /`runOsAssistant`/);
  assert.match(src, /`runTabAgent`/);
  assert.match(src, /every write there parks behind the user-confirm gate/);
  assert.doesNotMatch(src, /NO structural confirm step/, 'the interactive assistants are confirm-gated now; the comment must not say otherwise');
  assert.doesNotMatch(src, /TWO doors consult this/);
  assert.doesNotMatch(src, /does NOT consult it/);
  assert.doesNotMatch(src, /ONE door consults this today/);
});

test('a PERSON keeps every agent-forbidden tool: the MCP registry and dispatch never consult the table', () => {
  // The table is consulted at agent-facing doors only. The human's own surface — tools/list by
  // role, and `handleRpc` — must be untouched, or "an agent may not approve" would have quietly
  // become "nobody may approve over MCP".
  const admin = new Set(listToolsForRole('admin', ALL_MCP_TOOLS).map((t) => t.name));
  for (const name of ['decide_deploy', 'promote', 'decide_approval', 'promote_connection']) {
    assert.ok(admin.has(name), `${name} is still listed for a human admin`);
  }
  const builder = new Set(listToolsForRole('builder', ALL_MCP_TOOLS).map((t) => t.name));
  assert.ok(builder.has('decide_approval') && builder.has('decide_deploy'), 'a Builder still decides what a Builder decides');
  // Every name in the table, at the role its own floor names — derived, so a tool added to the
  // table later is covered here without anyone remembering to list it.
  for (const name of Object.keys(AGENT_FORBIDDEN_TOOLS)) {
    const tool = ALL_MCP_TOOLS.find((t) => t.name === name);
    assert.ok(tool, `${name} is registered`);
    assert.ok(listToolsForRole(tool!.minRole, ALL_MCP_TOOLS).some((t) => t.name === name), `${name} is still listed for a human ${tool!.minRole}`);
  }
  const domainAdmin = new Set(listToolsForRole('domain_admin', ALL_MCP_TOOLS).map((t) => t.name));
  assert.ok(domainAdmin.has('revoke_action_adoption'), 'a domain admin still revokes an adoption over MCP');
  // The person's path is `app/api/mcp/route.ts` → `serveMcp` (`http.ts`) → `handleRpc`
  // (`server.ts`). Neither module may reach the agent tables: not the forbidden list, not the hold.
  for (const file of ['server.ts', 'http.ts']) {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), file), 'utf8');
    assert.doesNotMatch(src, /agentForbiddenReason|AGENT_FORBIDDEN_TOOLS/, `${file} must not consult the agent table`);
    assert.doesNotMatch(src, /write-tool-meta|build\/hold|holdDecision/, `${file} must not consult the hold either`);
    // Nor the user-confirm classification: a person's own MCP client is never confirm-gated.
    assert.doesNotMatch(src, /tool-classes|needsUserConfirm|CONFIRM_FREE/, `${file} must not consult the confirm classes`);
  }
});

// --- THE REGISTRY-WIDE RATCHET (review H2) ---------------------------------------------------
//
// The platform ratchet (`tabs/software/lib/builder/dispatch.test.ts`) only ever covered tools that
// DECLARE `write: true`, and only the platform surface has that flag. Everything else in the
// registry was classified by nobody: `decide_approval` — which decides any queued request — was
// invisible to the hold gate under every preset until the review found it by reading.
//
// So: every tool in `ALL_MCP_TOOLS` is in EXACTLY ONE of
//   - the write catalog (`WRITE_TOOL_TABS`, which includes every agent-forbidden tool),
//   - READ_TOOLS — reviewed, changes no governed state,
//   - UNCLASSIFIED_BACKLOG — changes state (or may), and NOT YET given a hold posture.
// Two-way: a NEW tool fails until someone puts it in one of the three; a tool that leaves the
// registry or gets classified fails until its line is removed. The backlog cannot grow silently,
// and — the point — it cannot be mistaken for a list of reads.
//
// LIMIT: this is `ALL_MCP_TOOLS` as registered in the test environment. A bundle behind a feature
// flag that is off here is not in it.

// READ_TOOLS and UNCLASSIFIED_BACKLOG are PRODUCTION lists now (`core/mcp/tool-classes.ts`): the
// user-confirm predicate reads them, so they can no longer live only in a test. This ratchet
// imports them — it still pins the hold gate's three buckets; `tool-classes.test.ts` pins the
// confirm classes built on top.

test('REGISTRY RATCHET: every MCP tool is a classified write, a reviewed read, or on the named backlog — exactly one', () => {
  const registry = ALL_MCP_TOOLS.map((t) => t.name);
  assert.equal(new Set(registry).size, registry.length, 'tool names are unique');
  const buckets: Record<string, string[]> = { write: [], read: [], backlog: [] };
  const reads = new Set(READ_TOOLS);
  const backlog = new Set(UNCLASSIFIED_BACKLOG);
  assert.equal(reads.size, READ_TOOLS.length, 'READ_TOOLS has a duplicate');
  assert.equal(backlog.size, UNCLASSIFIED_BACKLOG.length, 'UNCLASSIFIED_BACKLOG has a duplicate');
  const unplaced: string[] = [];
  const multiply: string[] = [];
  for (const name of registry) {
    const hits = [WRITE_TOOL_NAMES.has(name) && 'write', reads.has(name) && 'read', backlog.has(name) && 'backlog'].filter(Boolean) as string[];
    if (hits.length === 0) unplaced.push(name);
    else if (hits.length > 1) multiply.push(`${name} (${hits.join('+')})`);
    else buckets[hits[0]].push(name);
  }
  assert.deepEqual(unplaced, [], 'a NEW tool: classify it in write-tool-meta.ts, or add it to READ_TOOLS (if it changes nothing) or to the backlog WITH a comment — both in core/mcp/tool-classes.ts');
  assert.deepEqual(multiply, [], 'a tool sits in more than one bucket');
  // The other direction: nothing listed that the registry no longer has (a stale line hides a rename).
  const known = new Set(registry);
  assert.deepEqual(READ_TOOLS.filter((n) => !known.has(n)), [], 'READ_TOOLS names a tool that is not registered');
  assert.deepEqual(UNCLASSIFIED_BACKLOG.filter((n) => !known.has(n)), [], 'the backlog names a tool that is not registered');
  assert.deepEqual([...WRITE_TOOL_NAMES].filter((n) => !known.has(n)), [], 'the write catalog names a tool that is not registered');
  // And every agent-forbidden tool is a real, registered tool.
  assert.deepEqual(Object.keys(AGENT_FORBIDDEN_TOOLS).filter((n) => !known.has(n)), []);
  // The backlog is pinned EXACTLY, so shrinking it is a visible, reviewed diff — and growing it is too.
  assert.deepEqual(buckets.backlog.sort(), ['get_software_status']);
  assert.equal(buckets.write.length + buckets.read.length + buckets.backlog.length, registry.length);
});
