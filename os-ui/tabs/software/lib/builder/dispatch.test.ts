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
import { WRITE_TOOL_NAMES } from '@core/mcp/write-tool-meta';
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
  // The fix: the build tool is held-eligible. Before this, `holdDecisionFor(preset,'commit')`
  // answered "not a write" for EVERY preset, so even a read-only agent could write app files.
  assert.ok(WRITE_TOOL_NAMES.has('commit'));
  // The pre-existing gap, pinned rather than tolerated: a NEW platform write tool fails this test
  // until someone classifies it in `core/mcp/write-tool-meta.ts` or adds it here deliberately.
  // Closing the rest changes the shipped Software Delivery Team's posture and the frozen engine
  // goldens, so it belongs to the software stream — see the report's cross-stream findings.
  assert.deepEqual(
    declared.filter((n) => !WRITE_TOOL_NAMES.has(n)).sort(),
    [
      'archive',
      'create_software',
      'decide_deploy',
      'delete',
      'design_software',
      'promote',
      'request_deploy',
      'set_app_spec',
      'start_preview',
      'use_as_data',
      'use_connection',
      'use_data',
      'use_knowledge',
    ],
  );
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
