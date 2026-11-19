/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    Tests for the flag that routes Build to the agentic builder
 * USER STORY: As the operator rolling this out I want proof that the default changes NOTHING about
 *             today's Build, and that the new builder is reached by exactly one guarded line.
 * ARCHITECTURE:
 *   - The default is asserted directly from the pure `dispatch.ts`.
 *   - "Byte-identical when off" is asserted STRUCTURALLY, which is the only honest way to assert it
 *     without a live model: the whole tree contains exactly ONE `agenticBuilderEnabled()` call
 *     site, it is a single early-return line inside `case 'build_software'`, and the statements
 *     that followed it before are unchanged and still reached. With the flag off the guard is
 *     false, so the dispatch executes exactly the statements it executed before this stream.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WRITE_TOOL_NAMES, agentForbiddenReason } from '@core/mcp/write-tool-meta';
import { PLATFORM_MCP_TOOLS } from '../platform-mcp.ts';
import { agenticBuilderEnabled, softwareBuilderMode } from './dispatch.ts';

const DISPATCH_FILE = join(process.cwd(), 'tabs', 'software', 'lib', 'platform-mcp.ts');
const GUARD_LINE = 'if (agenticBuilderEnabled()) { result = await agenticBuild(user, app, target); break; }';

test('H13 the builder defaults to `spec` — the agentic loop is opt-in only', () => {
  // No SOFTWARE_BUILDER in the test environment, so this is the shipped default.
  assert.equal(softwareBuilderMode(), 'spec');
  assert.equal(agenticBuilderEnabled(), false);
});

test('H13 the dispatch is reached by EXACTLY ONE guarded line', () => {
  const src = readFileSync(DISPATCH_FILE, 'utf8');
  const calls = src.split('agenticBuilderEnabled()').length - 1;
  assert.equal(calls, 1, 'the flag must be consulted in exactly one place in the build dispatch');
  const lines = src.split('\n').map((l) => l.trim());
  assert.equal(lines.filter((l) => l === GUARD_LINE).length, 1, `the guard must be this one line:\n${GUARD_LINE}`);
});

test('H13 with the flag off the original Build directive path is intact and still reached', () => {
  const src = readFileSync(DISPATCH_FILE, 'utf8');
  const caseStart = src.indexOf("case 'build_software': {");
  assert.ok(caseStart > 0, 'the build dispatch case must still exist');
  const caseEnd = src.indexOf("case 'verify_software':", caseStart);
  const block = src.slice(caseStart, caseEnd);
  // The guard sits AFTER the gate and BEFORE the directive, and nothing below it was removed.
  const guardAt = block.indexOf(GUARD_LINE);
  assert.ok(guardAt > 0, 'the guard must live inside the build_software case');
  assert.ok(block.indexOf('if (!gate.ok) throw withStatus') < guardAt, 'the design-before-build gate still runs first');
  const after = block.slice(guardAt);
  for (const statement of [
    'const buildGrants = await resolveGrantedContext(app.grants, user);',
    "stage: 'build',",
    "tier: 'standard',",
    "gate: 'passed',",
    "directive: stageDirective(app, target, 'build', buildGrants),",
    'progress: targetProgress(app, target),',
    'code: await committedFiles(appId, user),',
  ]) {
    assert.ok(after.includes(statement), `the default Build path lost: ${statement}`);
  }
});

test('H13 only the exact string `agentic` switches the builder', () => {
  // `softwareBuilder` is resolved in config.ts as `env(...) === 'agentic' ? 'agentic' : 'spec'`,
  // so a typo, an empty value or a legacy value can never silently enable a different builder.
  const config = readFileSync(join(process.cwd(), 'core', 'kernel', 'config.ts'), 'utf8');
  assert.ok(
    config.includes("softwareBuilder: env('SOFTWARE_BUILDER', 'spec') === 'agentic' ? 'agentic' : 'spec'"),
    'the config key must fail safe to `spec`',
  );
});

// ------------------------------- the write path and the trace (H10 / H12) ---------
//
// `loop-server.ts` is the only module that touches the real world, and two of its properties are
// governance claims rather than behaviour this harness can exercise without a cluster. They are
// asserted over its source: there is exactly ONE write, it goes through the governed commit door
// AS the signed-in user, and every loop step becomes a governed trace span.

const LOOP_SERVER = readFileSync(join(process.cwd(), 'tabs', 'software', 'lib', 'builder', 'loop-server.ts'), 'utf8');

test('H10 the loop writes ONLY through the governed commit door, as the signed-in user', () => {
  // One write call site, and the acting user is passed through to it.
  assert.equal(LOOP_SERVER.split('await commitToApp(').length - 1, 1);
  assert.ok(LOOP_SERVER.includes('await commitToApp(app.id, user, withRecord, message)'));
  // M-5: the ONE write carries the code AND the scorecard that describes it, in one commit.
  assert.ok(LOOP_SERVER.includes('const withRecord = [...files, { path: ACCEPTANCE_FILE'));
  // No second write path: no direct mirror/snapshot write, no store import, no service principal.
  for (const forbidden of ['snapshotFiles(', 'persistApp(', 'setAppSpec(', 'authorThroughFrontDoor(']) {
    assert.ok(!LOOP_SERVER.includes(forbidden), `the builder must not write via ${forbidden}`);
  }
  // The loop module itself cannot write at all — it only calls the injected dep.
  const loop = readFileSync(join(process.cwd(), 'tabs', 'software', 'lib', 'builder', 'loop.ts'), 'utf8');
  assert.ok(!loop.includes('commitToApp'), 'loop.ts must stay pure — the commit door is injected');
  assert.equal(loop.split('deps.commit(').length - 1, 2, 'the loop commits in exactly two places: on pass, and on a green budget stop');
});

test('H12 every loop step becomes a governed trace span under the run', () => {
  assert.ok(LOOP_SERVER.includes("import { trace } from '@core/infra/agent-governed';"));
  assert.ok(LOOP_SERVER.includes('onStep: async (step) => {'), 'the trace hangs off the loop\'s own step hook');
  assert.ok(LOOP_SERVER.includes('tool: `appsmith.${step.kind}`'), 'the span is named for the step');
  assert.ok(LOOP_SERVER.includes('principal: user.id'), 'the span is attributed to the acting user');
  assert.ok(
    LOOP_SERVER.includes('...(traceContext ? { run: traceContext } : {})'),
    'under a run the span nests in the run trace instead of standing alone',
  );
  // L-2: inside an agent run the governed surface already carries the run id, so the build nests
  // under the run's trace without a new argument at the dispatch call site.
  assert.ok(LOOP_SERVER.includes("import { currentSurface } from '@core/infra/request-surface';"));
  assert.ok(LOOP_SERVER.includes('currentSurface()?.runId ? { traceId: currentSurface()!.runId! } : undefined'));
});

test('H14 the coder model role is additive and falls back to the reasoning tier', () => {
  const roles = readFileSync(join(process.cwd(), 'core', 'models', 'roles.ts'), 'utf8');
  assert.ok(roles.includes("if (role === 'coder') {"));
  assert.ok(roles.includes("return pinned && pinned.trim().length > 0 ? pinned : roleDefault('reasoning');"));
  // And the builder asks for the role, never for a hard-coded model id.
  assert.ok(LOOP_SERVER.includes("roleModel(role)"));
  assert.ok(LOOP_SERVER.includes("completeAs(user, 'coder')"));
  assert.ok(LOOP_SERVER.includes("completeAs(user, 'reasoning')"));
});

// ---------------------- H-1: the platform write surface the hold gate can see ------
//
// `core/mcp/write-tool-meta.test.ts` lists the platform-MCP write tools as a LITERAL, because a
// core test must not import a tab. This is the other half of that assertion — it runs INSIDE the
// software tab, where `PLATFORM_MCP_TOOLS` is its own module, so the literal and the real surface
// cannot drift apart silently.

test('H-1 `commit` is visible to the agent hold gate; the rest of the platform surface is NAMED', () => {
  const declared = PLATFORM_MCP_TOOLS.filter((t) => t.write).map((t) => t.name);
  assert.ok(declared.includes('commit'), 'commit must still be a declared platform write');
  // NIGHT-2 MERGE: this tripwire did its job — S's `push_app_files` arrived as a platform write
  // that the hold gate could not see, so it was CLASSIFIED in `core/mcp/write-tool-meta.ts`
  // (not added to the unclassified list below). It writes an app's source tree, exactly like
  // `commit`, and must be held-eligible for the same reason.
  assert.ok(declared.includes('push_app_files'), 'push_app_files must still be a declared platform write');
  assert.ok(WRITE_TOOL_NAMES.has('push_app_files'), 'push_app_files must be in the hold-gate table');
  // 2026-11-19: and it did its job a THIRD time — `set_app_spec` was a declared platform write
  // that PUBLISHES a live app, and the hold gate could not see it. Classified, not excused.
  assert.ok(declared.includes('set_app_spec'), 'set_app_spec must still be a declared platform write');
  assert.ok(WRITE_TOOL_NAMES.has('set_app_spec'), 'set_app_spec publishes a live app — it must be held-eligible');
  // And a FOURTH: `design_software` is the platform-MCP twin of the tab's own `set_app_design`.
  // Both land in `patchAppDesign`, so leaving one unclassified made a write's hold posture depend
  // on which of its two names an agent happened to call.
  assert.ok(declared.includes('design_software'), 'design_software must still be a declared platform write');
  assert.ok(
    WRITE_TOOL_NAMES.has('design_software') && WRITE_TOOL_NAMES.has('set_app_design'),
    'the two doors onto patchAppDesign must be classified TOGETHER or the hold depends on the name used',
  );
  // The fix: the build tool is held-eligible. Before this, `holdDecisionFor(preset,'commit')`
  // answered "not a write" for EVERY preset, so even a read-only agent could write app files.
  assert.ok(WRITE_TOOL_NAMES.has('commit'));
  // 2026-11-19 — THE RATCHET REACHES ZERO. The eleven that were named here (`archive`,
  // `create_software`, `decide_deploy`, `delete`, `promote`, `request_deploy`, `start_preview`,
  // `use_as_data`, `use_connection`, `use_data`, `use_knowledge`) are all classified in
  // `core/mcp/write-tool-meta.ts`, with three different postures decided by the owner — see
  // `tabs/agents/lib/build/hold.ts` and the per-tool tests in `tabs/agents/lib/build/os-tools.test.ts`.
  // It stays a two-way ratchet: a NEW platform write fails this until someone classifies it.
  // "Classified" is not "held" (that lesson has now cost five times), so the posture of each is
  // pinned too — see the next test for where, and why it is not here.
  assert.deepEqual(declared.filter((n) => !WRITE_TOOL_NAMES.has(n)).sort(), []);
});

test('H-1 the declared platform write surface is EXACTLY the fifteen the posture tests name', () => {
  // The posture of each write (refused / always held / personal) is decided by `hold.ts` in the
  // AGENTS tab, and a tab may not import another tab — so the per-tool posture tests live there
  // (`tabs/agents/lib/build/os-tools.test.ts`) over a LITERAL list of these names. This is the
  // other half: the literal and the real surface cannot drift, because a platform write added or
  // renamed here fails this test until the posture list over there is updated with it.
  const declared = PLATFORM_MCP_TOOLS.filter((t) => t.write).map((t) => t.name).sort();
  assert.deepEqual(declared, [
    'archive', 'commit', 'create_software', 'decide_deploy', 'delete', 'design_software', 'promote',
    'push_app_files', 'request_deploy', 'set_app_spec', 'start_preview', 'use_as_data',
    'use_connection', 'use_data', 'use_knowledge',
  ]);
  // The one posture this tab CAN assert (the table is in core): approvals are closed to agents,
  // and nothing else on this surface is — in particular REQUESTING a deploy is not approving one.
  assert.deepEqual(declared.filter((n) => agentForbiddenReason(n) !== null), ['decide_deploy', 'promote']);
});

// ------------------------------- M-6: the deadlock tripwire ------------------------
//
// This stream shipped, then fixed, a module cycle: a static `handleRpc` import in
// `grounding-server.ts` closed `core/mcp/server` -> register-experimental -> platform-tools ->
// platform-mcp -> loop-server -> grounding-server -> core/mcp/server on a PENDING top-level await,
// and 28 test files hung. A grep for the lazy import pins that one file; this pins the PROPERTY,
// wherever a future edge reappears.

test('M-6 importing @core/mcp/server through the Build dispatch terminates', async () => {
  const guard = new Promise<never>((_, reject) => {
    const t = setTimeout(() => reject(new Error('import did not settle in 20s — a module cycle is back: something the Build dispatch reaches now takes a STATIC edge to @core/mcp/server, whose top-level await then never resolves')), 20_000);
    t.unref?.();
  });
  const mod = await Promise.race([import('@core/mcp/server'), guard]);
  assert.ok(typeof (mod as { handleRpc?: unknown }).handleRpc === 'function');
  // And the dispatch's own module graph loads too — this is the edge that closed the cycle.
  const builder = await Promise.race([import('./loop-server.ts'), guard]);
  assert.ok(typeof (builder as { agenticBuild?: unknown }).agenticBuild === 'function');
});
