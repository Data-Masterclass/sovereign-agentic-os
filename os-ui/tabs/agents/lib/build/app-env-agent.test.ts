/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Agent runs may not change an app's Prod env or secrets; Dev changes are held
 * USER STORY: As the owner I want an agent run's `set_app_env` / `unset_app_env` on Prod refused
 *             outright with a typed error (never held), on Dev held for a person, and a missing or
 *             unknown env treated as Prod — while a person in the UI or their own MCP session keeps
 *             exactly the rights they had (owner decision 2026-11-27, App Builder D).
 * ARCHITECTURE:
 *   - Drives the real agent doors: `agentToolGate` (precheck + gate 0 + hold), `phaseToolExecutor`
 *     behind `userConfirmGate` (the team panel), and the pure rules in write-tool-meta / hold.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CurrentUser } from '@core/kernel/auth';
import { parseSystem, type System } from '@tabs/agents/lib/system-schema';
import { AGENT_ENV_SCOPED_TOOLS, agentForbiddenCallReason, agentForbiddenReason, agentRefusedByArgs, WRITE_TOOL_NAMES } from '@core/mcp/write-tool-meta';
import { holdDecisionFor, holdDecisionForCall, holdReason, writeTargetScope } from '@tabs/agents/lib/build/hold';
import { agentToolGate, grantedToolExecutor, type OsToolDeps } from '@tabs/agents/lib/build/os-tools';
import { phaseToolExecutor } from '@tabs/agents/lib/build/phase-tools';
import { userConfirmGate, type ConfirmationPort } from '@core/runtime/confirm-gate';

const TOOLS = ['set_app_env', 'unset_app_env'] as const;
const PRESETS = ['read-only', 'read-propose', 'read-bounded', 'full-in-scope'] as const;
const ADMIN: CurrentUser = { id: 'u_admin', name: 'Ada Admin', domains: ['sales'], role: 'admin' };
/** Every env value that must count as Prod: prod itself, none, unknown, wrong case, not a string. */
const PRODLIKE: { label: string; env: unknown }[] = [
  { label: 'prod', env: 'prod' },
  { label: 'missing', env: undefined },
  { label: 'empty', env: '' },
  { label: 'unknown', env: 'qa' },
  { label: 'upper-case DEV', env: 'DEV' },
  { label: 'non-string', env: ['dev'] },
];

const argsFor = (tool: string, env: unknown) => ({
  appId: 'app_ab12cd',
  name: 'PAYMENT_API_KEY',
  ...(tool === 'set_app_env' ? { value: 'v' } : {}),
  ...(env === undefined ? {} : { env }),
});

function sys(tools: string[], preset: (typeof PRESETS)[number]): System {
  return parseSystem({
    version: '1',
    system: { name: 'T', domain: 'sales', visibility: 'Personal' },
    runtime: 'langgraph',
    entrypoint: 'a',
    grants: { tools },
    safety_preset: preset,
    agents: [{ id: 'a', role: 'agent', agent_md: '', memory_md: '' }],
  });
}

function spyDeps(): OsToolDeps & { calls: { handleRpc: unknown[]; enqueue: { tool: string; approverRole: string }[] } } {
  const calls = { handleRpc: [] as unknown[], enqueue: [] as { tool: string; approverRole: string }[] };
  const base: OsToolDeps = {
    enqueue: ((input: { tool: string; approverRole: string }) => {
      calls.enqueue.push(input);
      return {} as never;
    }) as unknown as OsToolDeps['enqueue'],
    handleRpc: (async (_user, req) => {
      calls.handleRpc.push(req);
      return { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ran' }] } };
    }) as OsToolDeps['handleRpc'],
    trace: (async () => ({}) as never) as OsToolDeps['trace'],
  };
  return Object.assign(base, { calls });
}

const errorOf = (text: string) => (JSON.parse(text) as { error: { code: string; reason: string } }).error;

test('agentForbiddenCallReason: Dev is allowed, Prod / missing / unknown env is refused, other tools untouched', () => {
  assert.deepEqual(Object.keys(AGENT_ENV_SCOPED_TOOLS).sort(), [...TOOLS].sort());
  for (const tool of TOOLS) {
    assert.ok(WRITE_TOOL_NAMES.has(tool), `${tool} is a classified write`);
    assert.equal(agentForbiddenReason(tool), null, `${tool} stays advertised (Dev is a legitimate, held call)`);
    assert.equal(agentForbiddenCallReason(tool, argsFor(tool, 'dev')), null);
    assert.equal(agentRefusedByArgs(tool, argsFor(tool, 'dev')), false);
    for (const { label, env } of PRODLIKE) {
      const reason = agentForbiddenCallReason(tool, argsFor(tool, env));
      assert.ok(reason, `${tool} ${label}: refused`);
      assert.match(reason!, /may never change an app's Prod env/);
      assert.match(reason!, /nothing was queued for approval/);
      assert.equal(agentRefusedByArgs(tool, argsFor(tool, env)), true);
    }
    assert.ok(agentForbiddenCallReason(tool, null), `${tool} with no args at all: refused`);
  }
  // A name-closed tool is still closed whatever its args; an ordinary write is not closed by args.
  assert.ok(agentForbiddenCallReason('decide_deploy', { env: 'dev' }));
  assert.equal(agentRefusedByArgs('decide_deploy', { env: 'dev' }), false, 'name-closed, not args-closed');
  assert.equal(agentForbiddenCallReason('create_dataset', { env: 'prod' }), null);
  assert.equal(agentForbiddenCallReason('create_app_database', { env: 'prod' }), null, 'out of this decision');
  assert.equal(agentForbiddenCallReason('constructor', {}), null);
});

test('hold: a Dev env change is held for a domain admin under EVERY preset (was personal, unheld)', () => {
  for (const tool of TOOLS) {
    assert.equal(writeTargetScope(tool), 'domain');
    assert.equal(holdReason(tool).label, 'always-confirmed');
    assert.match(holdReason(tool).why, /Dev env/);
    for (const preset of PRESETS) {
      const want = preset === 'read-only' ? { held: true, approverRole: 'admin' } : { held: true, approverRole: 'domain_admin' };
      assert.deepEqual(holdDecisionFor(preset, tool), want, `${tool} ${preset}`);
      assert.deepEqual(holdDecisionForCall(preset, tool, argsFor(tool, 'dev')), want, `${tool} ${preset} dev (per call)`);
      // Per call, Prod is NOT held: the executor's gate 0 refuses it, nobody is asked to approve it.
      for (const { label, env } of PRODLIKE) {
        assert.deepEqual(holdDecisionForCall(preset, tool, argsFor(tool, env)), { held: false }, `${tool} ${preset} ${label}`);
      }
    }
  }
  // Every other call keeps the name-only rule.
  assert.deepEqual(holdDecisionForCall('full-in-scope', 'decide_deploy', {}), holdDecisionFor('full-in-scope', 'decide_deploy'));
  assert.deepEqual(holdDecisionForCall('read-propose', 'create_dataset', {}), { held: false });
});

for (const tool of TOOLS) {
  test(`agent run: ${tool} on Prod (and missing/unknown env) is REFUSED with a typed error — never held, never run`, async () => {
    for (const preset of PRESETS) {
      for (const { label, env } of PRODLIKE) {
        const deps = spyDeps();
        const gate = agentToolGate(ADMIN, sys([tool], preset), 'sys1', deps);
        const args = argsFor(tool, env);
        // The engine asks before it holds: the refusal comes back here, so no card is ever filed.
        const pre = await gate.precheck(tool, args);
        assert.ok(pre, `${preset} ${label}: precheck refuses`);
        assert.equal(errorOf(pre!.text).code, 'forbidden');
        const res = await gate.callTool(tool, args);
        assert.equal(res.isError, true);
        const err = errorOf(res.text);
        assert.equal(err.code, 'forbidden', `${preset} ${label}`);
        assert.match(err.reason, /Prod env/);
        assert.equal(deps.calls.enqueue.length, 0, `${preset} ${label}: not held`);
        assert.equal(deps.calls.handleRpc.length, 0, `${preset} ${label}: not run`);
      }
    }
  });

  test(`agent run: ${tool} on Dev is HELD for a person and never run unapproved`, async () => {
    for (const preset of PRESETS) {
      const deps = spyDeps();
      const gate = agentToolGate(ADMIN, sys([tool], preset), 'sys1', deps);
      assert.equal(await gate.precheck(tool, argsFor(tool, 'dev')), null, `${preset}: precheck lets the hold decide`);
      const res = await grantedToolExecutor(ADMIN, sys([tool], preset), 'sys1', deps)(tool, argsFor(tool, 'dev'));
      assert.equal(errorOf(res.text).code, 'held', preset);
      assert.equal(deps.calls.enqueue.length, 1);
      assert.equal(deps.calls.enqueue[0].tool, tool);
      assert.equal(deps.calls.enqueue[0].approverRole, preset === 'read-only' ? 'admin' : 'domain_admin');
      assert.equal(deps.calls.handleRpc.length, 0, 'never executed before approval');
    }
  });

  test(`team panel: ${tool} on Prod is refused by the phase door and never offered for confirmation`, async () => {
    const inner: string[] = [];
    const exec = phaseToolExecutor(async (n) => {
      inner.push(n);
      return { text: 'ran', isError: false };
    }, [tool]);
    for (const { label, env } of PRODLIKE) {
      const res = await exec(tool, argsFor(tool, env));
      assert.equal(res.isError, true, label);
      assert.equal(errorOf(res.text).code, 'forbidden', label);
    }
    assert.deepEqual(inner, [], 'the inner executor never ran a Prod call');
    // Dev passes the phase door (the user-confirm gate in front parks it for the person).
    await exec(tool, argsFor(tool, 'dev'));
    assert.deepEqual(inner, [tool]);

    // The confirm gate in front: a Prod call goes straight to the refusing door, never parked.
    const created: unknown[] = [];
    const port: ConfirmationPort = {
      create: async (p) => {
        created.push(p);
        return { confirmationId: 'c1', tool: p.tool, args: p.args } as never;
      },
    } as ConfirmationPort;
    const gated = userConfirmGate(exec, { userId: 'u1', conversationId: 'conv', surface: 'team', refusedByInner: (t, a) => t !== tool || agentForbiddenCallReason(t, a) !== null }, port);
    const prod = await gated(tool, argsFor(tool, 'prod'));
    assert.equal(errorOf(prod.text).code, 'forbidden');
    assert.equal(created.length, 0, 'a Prod call is never offered for confirmation');
    const dev = await gated(tool, argsFor(tool, 'dev'));
    assert.ok((dev as { parked?: unknown }).parked, 'a Dev call is parked for the person');
    assert.equal(created.length, 1);
  });
}

test('a PERSON is unchanged: the tools and the human MCP door never consult the agent tables', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const os = resolve(here, '..', '..', '..', '..');
  // The tools themselves decide Prod for a person with `assertEnvWrite` (the go-live right), as before.
  const dtools = readFileSync(resolve(os, 'tabs/software/mcp/app-builder/d-tools.ts'), 'utf8');
  assert.match(dtools, /assertEnvWrite\(app, user, env\)/);
  assert.doesNotMatch(dtools, /agentForbidden|AGENT_ENV_SCOPED_TOOLS|write-tool-meta/);
  for (const file of ['core/mcp/server.ts', 'core/mcp/http.ts', 'app/api/apps/[id]/env/route.ts']) {
    assert.doesNotMatch(readFileSync(resolve(os, file), 'utf8'), /agentForbiddenCallReason|AGENT_ENV_SCOPED_TOOLS/, file);
  }
});
