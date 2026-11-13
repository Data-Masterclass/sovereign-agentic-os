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
  assert.ok(LOOP_SERVER.includes('await commitToApp(app.id, user, files, message)'));
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
    LOOP_SERVER.includes('...(overrides.traceContext ? { run: overrides.traceContext } : {})'),
    'under a run the span nests in the run trace instead of standing alone',
  );
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
