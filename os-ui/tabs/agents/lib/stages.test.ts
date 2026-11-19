/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * FEATURE:    A builder stage shows ✓ when its work is done — not when it was clicked through
 * USER STORY: As a team author I grant context (or open a team a colleague built) and the rail
 *             tells me the truth: Grant is ticked because something is granted, on first load,
 *             after a reload and whichever way I moved between stages.
 * ARCHITECTURE:
 *   - `AGENT_STAGES` (lib/stages.ts) declares each stage's gate, ✓ condition, problem and
 *     pending words; `agentStageCtx` derives the context from SAVED state only (the system
 *     definition, its last build, its last run).
 *   - The shared model (core/kernel/stages.ts) turns that into the rail; it holds no session
 *     progress, so a "reload" here is simply a fresh state over the re-parsed system.yaml.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_STAGES, agentStageCtx, aliasStageId, countContextGrants, type AgentStageCtx,
} from '@tabs/agents/lib/stages';
import { canEnter, goTo, initialStageState, isDone, isSatisfied, stageStatuses } from '@core/kernel/stages';
import { parseSystem, serializeSystem, type System } from '@tabs/agents/lib/system-schema';
import { addOutput, addSimpleAgent, setArtifactGrant, setDescription, setFolderGrant } from '@tabs/agents/lib/simple-edit';

const base: AgentStageCtx = {
  named: false,
  hasGoal: false,
  grantCount: 0,
  grantWarning: null,
  ready: false,
  builtOk: false,
  buildFailed: false,
  hasRun: false,
  runFailed: false,
  runInterrupted: false,
  checksPass: false,
};

/** A named system with nothing else — what Define leaves behind after only the name. */
const named = (): System => parseSystem('system: { name: Renewals desk, domain: d, visibility: Personal }\nentrypoint: ""\ngrants: {}\nagents: []');
const ctxOf = (system: System, over: Partial<Parameters<typeof agentStageCtx>[0]> = {}): AgentStageCtx =>
  agentStageCtx({ system, checksPass: () => true, ...over });
const marks = (c: AgentStageCtx) => Object.fromEntries(stageStatuses(AGENT_STAGES, initialStageState(AGENT_STAGES), c).map((r) => [r.id, r.mark]));
const labels = (c: AgentStageCtx) => Object.fromEntries(stageStatuses(AGENT_STAGES, initialStageState(AGENT_STAGES), c).map((r) => [r.id, r.label]));

test('stages: the six ids are define · grant · design · build · run · evaluate, in order', () => {
  assert.deepEqual(
    AGENT_STAGES.map((s) => s.id),
    ['define', 'grant', 'design', 'build', 'run', 'evaluate'],
  );
  assert.deepEqual(
    AGENT_STAGES.map((s) => s.title),
    ['Define', 'Grant', 'Design', 'Build', 'Run', 'Evaluate'],
  );
});

test('stages: Define is always reachable; Grant needs a named system', () => {
  assert.equal(canEnter(AGENT_STAGES, 'define', base), true);
  assert.equal(canEnter(AGENT_STAGES, 'grant', base), false);
  assert.equal(canEnter(AGENT_STAGES, 'grant', { ...base, named: true }), true);
});

test('stages: Design is always reachable (blank-canvas + auto-suggest)', () => {
  assert.equal(canEnter(AGENT_STAGES, 'design', base), true);
  assert.equal(canEnter(AGENT_STAGES, 'design', { ...base, named: true }), true);
});

test('stages: Build is gated on a runnable team (agents + entrypoint)', () => {
  assert.equal(canEnter(AGENT_STAGES, 'build', { ...base, named: true, ready: false }), false);
  assert.equal(canEnter(AGENT_STAGES, 'build', { ...base, ready: true }), true);
});

test('stages: Run is gated on a green build (ready + builtOk)', () => {
  assert.equal(canEnter(AGENT_STAGES, 'run', { ...base, ready: true, builtOk: false }), false);
  assert.equal(canEnter(AGENT_STAGES, 'run', { ...base, ready: false, builtOk: true }), false);
  assert.equal(canEnter(AGENT_STAGES, 'run', { ...base, ready: true, builtOk: true }), true);
});

test('stages: Evaluate is blocked until a run exists (and a runnable team)', () => {
  // Ready but no run → not reachable.
  assert.equal(canEnter(AGENT_STAGES, 'evaluate', { ...base, ready: true, hasRun: false }), false);
  // A run without a ready team is impossible in practice, but the gate needs both.
  assert.equal(canEnter(AGENT_STAGES, 'evaluate', { ...base, ready: false, hasRun: true }), false);
  assert.equal(canEnter(AGENT_STAGES, 'evaluate', { ...base, ready: true, hasRun: true }), true);
});

test('Define ✓ = named AND a described deliverable — a name alone is not a definition', () => {
  assert.equal(isSatisfied(AGENT_STAGES, 'define', base), false);
  assert.equal(isSatisfied(AGENT_STAGES, 'define', { ...base, named: true }), false);
  assert.equal(isSatisfied(AGENT_STAGES, 'define', { ...base, hasGoal: true }), false);
  assert.equal(isSatisfied(AGENT_STAGES, 'define', { ...base, named: true, hasGoal: true }), true);
  assert.equal(labels({ ...base, named: true }).define, 'Define: no deliverable described yet');
  assert.equal(labels(base).define, 'Define: no name yet');
});

test('Grant ✓ is about GRANTS, not the name: zero grants → un-ticked, with a quiet reason', () => {
  const c = ctxOf(named());
  assert.equal(c.named, true);
  assert.equal(c.grantCount, 0);
  assert.equal(isDone(AGENT_STAGES, 'grant', c), false, 'a named system with nothing granted is NOT ticked');
  assert.equal(marks(c).grant, 'todo');
  assert.equal(labels(c).grant, 'Grant: nothing granted yet');
  // … and it blocks nothing: Design is reachable regardless.
  assert.equal(canEnter(AGENT_STAGES, 'design', c), true);
});

test('Grant ✓ with one ITEM grant (a dataset)', () => {
  const c = ctxOf(setArtifactGrant(named(), 'data', 'ds_orders', false));
  assert.equal(c.grantCount, 1);
  assert.equal(marks(c).grant, 'done');
  assert.equal(labels(c).grant, 'Grant: done');
});

test('Grant ✓ with one FOLDER grant (a files folder)', () => {
  const sys = setFolderGrant(named(), 'files', { path: '/Invoices', scope: 'personal' }, false);
  assert.equal(countContextGrants(sys), 1);
  assert.equal(marks(ctxOf(sys)).grant, 'done');
});

test('Grant counts every kind the stage grants — data, knowledge, files, metrics, connections, plan', () => {
  const sys = named();
  sys.grants.data.push({ id: 'ds_1', capability: 'Read' });
  sys.grants.knowledge.push({ id: 'pk_1', capability: 'Read' }, { id: 'wf_1', capability: 'Read' });
  sys.grants.metrics.push({ id: 'm_1', capability: 'Read' });
  sys.grants.connections.push({ id: 'c_1', capability: 'Write-approval' });
  sys.grants.files.push({ id: '', capability: 'Read', folder: { path: '/', scope: 'domain' } });
  sys.grants.plan.push({ id: 'manual:d', capability: 'Read' });
  assert.equal(countContextGrants(sys), 7);
});

test('Grant with ONLY disabled grants is not ticked — Off / Blocked grant nothing', () => {
  const sys = named();
  sys.grants.data.push({ id: 'ds_1', capability: 'Off' });
  sys.grants.connections.push({ id: 'c_1', capability: 'Blocked' });
  sys.grants.files.push({ id: '', capability: 'Off', folder: { path: '/Invoices', scope: 'personal' } });
  assert.equal(countContextGrants(sys), 0);
  assert.equal(marks(ctxOf(sys)).grant, 'todo');
  // One of them switched on is enough.
  sys.grants.data[0].capability = 'Read';
  assert.equal(marks(ctxOf(sys)).grant, 'done');
  // A tools-only pool (no artifact, no folder) is not a context grant either.
  const toolsOnly = named();
  toolsOnly.grants.tools.push('query_data');
  assert.equal(countContextGrants(toolsOnly), 0);
});

test('a declared output\'s destination folder counts as a grant (the Grant stage shows it ticked)', () => {
  const sys = addOutput(named(), { kind: 'files', name: 'summary.md', folder: { path: '/Reports', scope: 'personal' } });
  assert.equal(countContextGrants(sys), 1);
});

test('Grant: a grant PROBLEM (the PR #106 zero-match hook) shows amber instead of ✓', () => {
  const sys = setFolderGrant(named(), 'files', { path: '/Invoices', scope: 'personal' }, false);
  const c = ctxOf(sys, { grantWarning: 'the folder /Invoices matches no file' });
  assert.equal(marks(c).grant, 'warn');
  assert.equal(labels(c).grant, 'Grant: the folder /Invoices matches no file');
  assert.equal(isDone(AGENT_STAGES, 'grant', c), false);
});

test('Design ✓ = ready (≥1 agent and a start agent)', () => {
  assert.equal(isSatisfied(AGENT_STAGES, 'design', base), false);
  assert.equal(isSatisfied(AGENT_STAGES, 'design', { ...base, ready: true }), true);
  assert.equal(ctxOf(named()).ready, false);
  assert.equal(ctxOf(addSimpleAgent(named(), { role: 'Analyst', instructions: 'Read the data.' })).ready, true);
});

test('Build ✓ = last build green on a runnable team; a FAILED build shows red, never ✓', () => {
  const team = addSimpleAgent(named(), { role: 'Analyst', instructions: 'Read the data.' });
  assert.equal(marks(ctxOf(team)).build, 'todo');
  assert.equal(labels(ctxOf(team)).build, 'Build: not built yet');
  assert.equal(marks(ctxOf(team, { lastBuild: { ok: true } })).build, 'done');
  const failed = ctxOf(team, { lastBuild: { ok: false } });
  assert.equal(marks(failed).build, 'error');
  assert.equal(labels(failed).build, 'Build: the last build failed');
  // A green build of a team that has since lost every agent is not a done Build.
  assert.equal(marks(ctxOf(named(), { lastBuild: { ok: true } })).build, 'todo');
});

test('Run ✓ = a run that produced a result; a FAILED run does not tick (red), an interrupted one is amber', () => {
  const team = addSimpleAgent(named(), { role: 'Analyst', instructions: 'Read the data.' });
  const built = { lastBuild: { ok: true } };
  assert.equal(marks(ctxOf(team, built)).run, 'todo');
  // A run record with neither nodes nor output is not a run.
  assert.equal(marks(ctxOf(team, { ...built, lastRun: { nodes: [] } })).run, 'todo');
  assert.equal(marks(ctxOf(team, { ...built, lastRun: { output: 'done' } })).run, 'done');
  assert.equal(marks(ctxOf(team, { ...built, lastRun: { nodes: [{}] } })).run, 'done');

  const failed = ctxOf(team, { ...built, lastRun: { nodes: [{}], failed: true } });
  assert.equal(failed.hasRun, true, 'a failed run still exists (Evaluate stays reachable)');
  assert.equal(isDone(AGENT_STAGES, 'run', failed), false);
  assert.equal(marks(failed).run, 'error');
  assert.equal(labels(failed).run, 'Run: the last run failed');
  assert.equal(canEnter(AGENT_STAGES, 'evaluate', failed), true);

  const cut = ctxOf(team, { ...built, lastRun: { nodes: [{}], interrupted: true } });
  assert.equal(marks(cut).run, 'warn');
  assert.equal(labels(cut).run, 'Run: the last run was interrupted');
});

test('Evaluate ✓ = the run\'s checks pass; failing checks show amber; checks are not asked without a run', () => {
  const team = addSimpleAgent(named(), { role: 'Analyst', instructions: 'Read the data.' });
  const ran = { lastBuild: { ok: true }, lastRun: { output: 'done' } };
  assert.equal(marks(ctxOf(team, ran)).evaluate, 'done');
  const failing = ctxOf(team, { ...ran, checksPass: () => false });
  assert.equal(marks(failing).evaluate, 'warn');
  assert.equal(labels(failing).evaluate, 'Evaluate: the last run did not pass every check');
  const noRun = ctxOf(team, { lastBuild: { ok: true }, checksPass: () => { throw new Error('must not be asked'); } });
  assert.equal(marks(noRun).evaluate, 'todo');
  assert.equal(labels(noRun).evaluate, 'Evaluate: no run to evaluate yet');
});

test('RELOAD: a built-and-run team re-read from system.yaml opens fully ticked, with nothing clicked', () => {
  let sys = setDescription(named(), 'A weekly margin report.');
  sys = setArtifactGrant(sys, 'data', 'ds_orders', false);
  sys = addSimpleAgent(sys, { role: 'Analyst', instructions: 'Read the data.' });
  const records = { lastBuild: { ok: true }, lastRun: { nodes: [{}], output: 'report' } };
  const before = stageStatuses(AGENT_STAGES, goTo(AGENT_STAGES, initialStageState(AGENT_STAGES), 'evaluate', ctxOf(sys, records)), ctxOf(sys, records));
  // The reload: only what was SAVED survives — re-parse the yaml, start a fresh stage state.
  const reloaded = parseSystem(serializeSystem(sys));
  const after = stageStatuses(AGENT_STAGES, initialStageState(AGENT_STAGES), ctxOf(reloaded, records));
  assert.deepEqual(after.map((r) => r.mark), ['done', 'done', 'done', 'done', 'done', 'done']);
  assert.deepEqual(after.map((r) => r.mark), before.map((r) => r.mark), 'the same rail before and after the reload');
  assert.equal(after[0].active, true, 'still opens on Define');
});

test('the owner\'s report: context granted, then left by the rail (no "next") → Grant is ticked', () => {
  let sys = setArtifactGrant(named(), 'data', 'ds_orders', false);
  sys = setArtifactGrant(sys, 'knowledge', 'pk_policy', false);
  sys = setFolderGrant(sys, 'files', { path: '/Invoices', scope: 'personal' }, false);
  const c = ctxOf(sys);
  const onGrant = goTo(AGENT_STAGES, initialStageState(AGENT_STAGES), 'grant', c);
  const jumpedAway = goTo(AGENT_STAGES, onGrant, 'design', c);
  for (const st of [onGrant, jumpedAway, initialStageState(AGENT_STAGES)]) {
    assert.equal(stageStatuses(AGENT_STAGES, st, c)[1].mark, 'done');
  }
  // Define is honest too: there is a name but no deliverable yet.
  assert.equal(stageStatuses(AGENT_STAGES, jumpedAway, c)[0].mark, 'todo');
});

test('aliasStageId: the legacy merged `build-run` id folds onto `build`', () => {
  assert.equal(aliasStageId('build-run'), 'build');
});

test('aliasStageId: current ids pass through; an unknown id falls back to define', () => {
  for (const id of ['define', 'grant', 'design', 'build', 'run', 'evaluate']) {
    assert.equal(aliasStageId(id), id);
  }
  assert.equal(aliasStageId('nope'), 'define');
  assert.equal(aliasStageId(''), 'define');
});
