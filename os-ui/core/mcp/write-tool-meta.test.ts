/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ALL_WRITE_TOOLS } from '@core/mcp/write-tools';
import { WRITE_TOOL_TABS, WRITE_TOOL_NAMES, AGENT_FORBIDDEN_TOOLS, agentForbiddenReason } from '@core/mcp/write-tool-meta';

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
const FACTORY_WRITE_TOOLS: Readonly<Record<string, string>> = { reindex_corpus: 'files' };

test('WRITE_TOOL_TABS matches ALL_WRITE_TOOLS plus the platform-MCP and factory writes (names and tabs)', () => {
  const actual = {
    ...Object.fromEntries(ALL_WRITE_TOOLS.map((t) => [t.name, t.tab])),
    ...PLATFORM_WRITE_TOOLS,
    ...FACTORY_WRITE_TOOLS,
  };
  assert.deepEqual(WRITE_TOOL_TABS, actual);
  assert.equal(
    WRITE_TOOL_NAMES.size,
    ALL_WRITE_TOOLS.length + Object.keys(PLATFORM_WRITE_TOOLS).length + Object.keys(FACTORY_WRITE_TOOLS).length,
    'duplicate write tool names',
  );
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
  for (const name of ['decide_deploy', 'promote']) {
    const reason = agentForbiddenReason(name);
    assert.ok(reason, `${name} must be closed to agent runs`);
    assert.match(reason!, /human decision/);
    assert.match(reason!, /four-eyes/);
  }
  assert.deepEqual(Object.keys(AGENT_FORBIDDEN_TOOLS).sort(), ['decide_deploy', 'promote', 'reindex_corpus']);
  // Requesting is not approving: the request side stays open to agents (and is held instead).
  assert.equal(agentForbiddenReason('request_deploy'), null);
});

test('AGENT_FORBIDDEN_TOOLS: the catalog names BOTH doors that consult it, and no longer claims a follow-up', () => {
  // History: the first version claimed `app-tool-call.ts` consulted this table when it did not,
  // and a comment that overstates a guard is worse than no comment — so the gap was pinned as a
  // stated follow-up. The follow-up is now CLOSED (the guard is in `callAppTool`, and its
  // behaviour is tested in `tabs/software/lib/app-tool-call.test.ts`); this pins the comment to
  // the new truth so it cannot drift in either direction.
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'write-tool-meta.ts'), 'utf8');
  assert.match(src, /TWO doors consult this/);
  assert.match(src, /`tabs\/agents\/lib\/build\/os-tools\.ts`/);
  assert.match(src, /`tabs\/software\/lib\/app-tool-call\.ts`/);
  assert.doesNotMatch(src, /does NOT consult it/);
  assert.doesNotMatch(src, /ONE door consults this today/);
});
