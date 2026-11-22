/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    A run saves its declared outputs — once, as the runner, where they were declared
 * USER STORY: As an author who chose "Where the results go" I want the report in that Files
 *             folder, the note in that Knowledge folder and the rows in that dataset after a run,
 *             with the run telling me per output where it went, what waits for a domain admin,
 *             and what was not saved and why — and never twice, even after a crash.
 * ARCHITECTURE:
 *   - A real `runOsTeam` over a SCRIPTED model (no tool is called by the model: producing the
 *     content is its whole job), then the real save (`saveRunOutputs` → `agentToolGate` →
 *     `checkGrantScope`) with the ONE thing injected that a tab's test may not import: the
 *     governed dispatch. `world()` is a small in-memory Files / Knowledge / Data / approvals
 *     behind `handleRpc`, recording the principal of every call.
 *   - The run-service cases (`executeTeamRun`) use the real agents store and the real
 *     checkpointer (memory): pending-before-save, "completed with unsaved outputs", the retry,
 *     and the resume of a thread that finished before its save was recorded.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import type { LlmCall } from '@core/runtime/agentic';
import { parseSystem, serializeSystem, type System } from '@tabs/agents/lib/system-schema';
import { addOutput } from '@tabs/agents/lib/simple-edit';
import { withOutputTools } from '@tabs/agents/lib/output-tools';
import { runOsTeam } from '@tabs/agents/lib/build/agentic-graph-server';
import type { OsToolDeps, ScopedItemsLoader } from '@tabs/agents/lib/build/os-tools';
import { outputDispatchFor, saveRunOutputs } from '@tabs/agents/lib/build/output-save-server';
import { executeTeamRun } from '@tabs/agents/lib/build/run-service';
import { outputFileName, outputSaveSystem, runTag, unsavedOutputs, type OutputResult, type ProducerRun } from '@tabs/agents/lib/output-saver';
import { createSystem, getSystemForRun, setLastRun, __resetStore } from '@tabs/agents/lib/store';
import { __setSystemKeyStoreForTests, deploymentKek, memorySystemKeyStore, mintSystemKey, sealSystemKey, systemKeyAlias } from '@core/infra/agent-system-keys';

const USER: CurrentUser = { id: 'alex', name: 'Alex', domains: ['finance'], allDomains: ['finance'], activeDomain: null, role: 'builder' };

const ROWS = '[{"invoice_no":"R-1001","net_amount":250.5,"paid":true},{"invoice_no":"R-1002","net_amount":90,"paid":false}]';
const REPORT = '# Invoice report\n\nTwo invoices were verified.';

/** reader → writer. `reader` returns the rows, `writer` the report. */
function team(): System {
  return parseSystem({
    version: '1',
    system: { name: 'Invoice Desk', domain: 'finance', visibility: 'Personal' },
    entrypoint: 'reader',
    grants: { tools: [] },
    agents: [
      { id: 'reader', role: 'reads the invoices', agent_md: 'Return a JSON list with one object per invoice.', memory_md: '' },
      { id: 'writer', role: 'writes the report', agent_md: 'Write the report.', memory_md: '' },
    ],
    edges: [{ from: 'reader', to: 'writer', type: 'handoff' }],
  });
}

function threeOutputs(scope: 'personal' | 'domain' = 'personal'): System {
  let sys = addOutput(team(), { kind: 'files', name: 'Report', folder: { path: '/reports', scope }, agent: 'writer' });
  sys = addOutput(sys, { kind: 'knowledge', name: 'Result', folder: { path: '/results', scope } });
  sys = addOutput(sys, { kind: 'data', name: 'Processed invoices', folder: { path: '/Finance/Processed', scope }, agent: 'reader' });
  return sys;
}

/** A model that never calls a tool: each agent answers with its scripted final text. */
function scripted(answers: Record<string, string | Error>): LlmCall {
  return async (req) => {
    const sysText = req.messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n');
    // The node is identified by its own instructions, which the engine puts in the system prompt.
    const id = sysText.includes('Write the report.') ? 'writer' : 'reader';
    const a = answers[id];
    if (a instanceof Error) throw a;
    return { content: a ?? '', toolCalls: [] };
  };
}

type Call = { user: CurrentUser; name: string; args: Record<string, unknown> };

/** An in-memory Files / Knowledge / Data / approvals behind the governed dispatch. */
function world() {
  const files: { id: string; name: string; folder: string; owner: string; tier: 'dataset' | 'asset'; description?: string; tags?: string[]; text?: string }[] = [];
  const notes: { id: string; title: string; md: string; folder: string; owner: string; sourceKey?: string; visibility: string }[] = [];
  const datasets: { id: string; name: string; folder: string; owner: string; tier: 'dataset' | 'asset'; documented: boolean; bronze: boolean; bronzeAt?: number; ingests: string[] }[] = [];
  const approvals: { id: string; kind: string; artifactId: string }[] = [];
  const calls: Call[] = [];
  const failing = new Map<string, string>();
  let n = 0;
  const next = (p: string) => `${p}_${String((n += 1)).padStart(3, '0')}`;
  const ok = (v: unknown) => ({ jsonrpc: '2.0' as const, id: 1, result: { content: [{ type: 'text', text: JSON.stringify(v) }] } });
  const err = (code: string, reason: string) => ({ jsonrpc: '2.0' as const, id: 1, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code, reason } }) }] } });
  const norm = (f: unknown) => (typeof f === 'string' && f.trim() ? (f.startsWith('/') ? f : `/${f}`) : '/');

  const handleRpc = (async (user: CurrentUser, req: { params?: unknown }) => {
    const { name, arguments: a = {} } = (req.params ?? {}) as { name: string; arguments?: Record<string, unknown> };
    calls.push({ user, name, args: a });
    if (failing.has(name)) return err('upstream_error', failing.get(name)!);
    switch (name) {
      case 'list_files':
        return ok({ mine: files.filter((f) => f.owner === user.id && f.tier === 'dataset'), domain: files.filter((f) => f.tier === 'asset'), marketplace: [] });
      case 'upload_file': {
        const f = { id: next('as'), name: String(a.name), folder: norm(a.folder), owner: user.id, tier: 'dataset' as const, description: a.description as string, tags: a.tags as string[], text: a.text as string };
        files.push(f);
        return ok(f);
      }
      case 'get_file': {
        const f = files.find((x) => x.id === a.fileId);
        return f ? ok(f) : err('not_found', 'File not found');
      }
      case 'save_knowledge_note': {
        const existing = notes.find((x) => x.owner === user.id && x.sourceKey && x.sourceKey === a.sourceKey);
        if (existing) return ok({ id: existing.id, title: existing.title, folder: existing.folder, visibility: existing.visibility, already: true });
        const note = { id: next('pk'), title: String(a.title), md: String(a.md), folder: norm(a.folder), owner: user.id, sourceKey: a.sourceKey as string, visibility: 'Personal' };
        notes.push(note);
        return ok({ id: note.id, title: note.title, folder: note.folder, visibility: 'Personal' });
      }
      case 'list_datasets':
        return ok({ mine: datasets.filter((d) => d.owner === user.id && d.tier === 'dataset'), domain: datasets.filter((d) => d.tier === 'asset'), marketplace: [] });
      case 'create_dataset': {
        if (datasets.some((d) => d.name.toLowerCase() === String(a.name).toLowerCase())) return err('conflict', `A dataset named “${String(a.name)}” already exists in finance — pick a unique name.`);
        const d = { id: next('ds'), name: String(a.name), folder: norm(a.folder), owner: user.id, tier: 'dataset' as const, documented: false, bronze: false, ingests: [] as string[] };
        datasets.push(d);
        return ok(d);
      }
      case 'ingest_dataset': {
        const d = datasets.find((x) => x.id === a.datasetId);
        if (!d) return err('not_found', 'Dataset not found');
        d.bronze = true;
        d.bronzeAt = Date.now();
        d.ingests.push(String(a.content));
        return ok({ ok: true, rowCount: String(a.content).trim().split('\n').length - 1, bronzeRegistered: true, datasetId: d.id });
      }
      case 'get_dataset': {
        const d = datasets.find((x) => x.id === a.datasetId);
        return d ? ok({ ...d, versions: { bronze: { built: d.bronze, ...(d.bronzeAt ? { updatedAt: new Date(d.bronzeAt).toISOString() } : {}) } } }) : err('not_found', 'Dataset not found');
      }
      case 'request_promotion': {
        if (a.kind === 'dataset') {
          const d = datasets.find((x) => x.id === a.id)!;
          if (!d.documented) return err('bad_request', 'Cannot promote — the dataset has no description. Complete the documentation first.');
        }
        const ap = { id: next('apr'), kind: String(a.kind), artifactId: String(a.id) };
        approvals.push(ap);
        return ok({ status: 'pending', approvalId: ap.id, requestId: ap.id });
      }
      default:
        return err('not_found', `Unknown tool ${name}`);
    }
  }) as unknown as OsToolDeps['handleRpc'];

  const toolDeps: OsToolDeps = {
    enqueue: (() => { throw new Error('the save never enqueues a hold by itself'); }) as OsToolDeps['enqueue'],
    handleRpc,
    trace: (async () => ({}) as never) as OsToolDeps['trace'],
    resolvers: {
      fileLocations: async () => files.map((f) => ({ id: f.id, folder: f.folder, lane: f.tier === 'asset' ? ('domain' as const) : ('personal' as const) })),
      datasetTables: async () => [],
    },
  };
  const load: ScopedItemsLoader = async (kind, scope) => {
    const lane = (tier: string) => (scope === 'personal' ? tier === 'dataset' : tier === 'asset');
    if (kind === 'files') return files.filter((f) => lane(f.tier)).map((f) => ({ id: f.id, folder: f.folder }));
    if (kind === 'data') return datasets.filter((d) => lane(d.tier)).map((d) => ({ id: d.id, folder: d.folder }));
    return notes.filter((x) => (scope === 'personal') === (x.visibility === 'Personal')).map((x) => ({ id: x.id, folder: x.folder }));
  };
  const writes = () => calls.filter((c) => ['upload_file', 'save_knowledge_note', 'create_dataset', 'ingest_dataset', 'request_promotion'].includes(c.name));
  return { files, notes, datasets, approvals, calls, failing, toolDeps, load, door: { toolDeps, load }, writes };
}

let seq = 0;
const newRun = () => `run_${String((seq += 1)).padStart(8, '0')}-0000-4000-8000-000000000000`;
const AT = Date.UTC(2026, 10, 19, 14, 5);

/** Run the team for real (scripted model), then save its outputs through the real gate. */
async function runAndSave(sys: System, answers: Record<string, string | Error>, w = world(), opts: { mode?: 'run' | 'by-hand'; previous?: OutputResult[]; runId?: string; at?: number } = {}) {
  const runId = opts.runId ?? newRun();
  const run = withOutputTools(sys);
  const team = await runOsTeam({ runId, user: USER, yaml: serializeSystem(run), systemId: 'sys-inv', messages: [{ role: 'user', content: 'Process the invoices.' }], llm: scripted(answers), toolDeps: w.toolDeps });
  const nodes: ProducerRun[] = team.runs.map((r) => ({ node: r.node, status: r.status, finalText: r.result.finalText }));
  const status = team.failed ? 'failed' as const : team.reachedEnd ? 'done' as const : 'incomplete' as const;
  const outputs = await saveRunOutputs({
    user: USER, system: run, systemId: 'sys-inv', runId, at: opts.at ?? AT, status,
    failure: team.failure ? { node: team.failure.node, reason: team.failure.reason } : undefined,
    nodes, previous: opts.previous, mode: opts.mode, ...w.door,
  });
  return { w, outputs, runId, team, nodes, run };
}

const byKind = (outputs: OutputResult[], kind: string) => outputs.find((o) => o.kind === kind)!;

// ------------------------------------------------------------------ cases --

test('File + Knowledge + Data outputs in My scope are all saved, in their folders, and the run reports each', async () => {
  const { w, outputs, runId } = await runAndSave(threeOutputs(), { reader: `Here are the rows:\n\n${ROWS}`, writer: REPORT });

  // FILE — the writer's report, dated, in the declared folder, with the run in its description.
  const fileName = `invoice-desk-2026-11-19-1405-${runTag(runId)}.md`;
  assert.equal(w.files.length, 1);
  assert.equal(w.files[0].name, fileName);
  assert.equal(w.files[0].folder, '/reports');
  assert.equal(w.files[0].text, REPORT);
  assert.match(w.files[0].description ?? '', new RegExp(`agent system “Invoice Desk” \\(agent writer\\), run ${runId}`));
  const file = byKind(outputs, 'files');
  assert.equal(file.state, 'saved');
  assert.equal(file.id, w.files[0].id);
  assert.equal(file.link, `/files?focus=${w.files[0].id}`);
  assert.equal(file.message, `Saved to My files /reports/${fileName}`);
  assert.equal(file.producer, 'writer');

  // KNOWLEDGE — no "written by": the FINAL agent's result, as a note in the declared folder.
  assert.equal(w.notes.length, 1);
  assert.equal(w.notes[0].folder, '/results');
  assert.equal(w.notes[0].title, 'Result — 2026-11-19 14:05 UTC');
  assert.ok(w.notes[0].md.startsWith(REPORT));
  assert.equal(byKind(outputs, 'knowledge').message, 'Saved to My knowledge /results as “Result — 2026-11-19 14:05 UTC”');
  assert.equal(byKind(outputs, 'knowledge').producer, 'writer');

  // DATA — the reader's rows, as the Bronze of one dataset in the declared folder.
  assert.equal(w.datasets.length, 1);
  assert.equal(w.datasets[0].name, 'Processed invoices');
  assert.equal(w.datasets[0].folder, '/Finance/Processed');
  assert.equal(w.datasets[0].ingests[0], 'invoice_no,net_amount,paid\nR-1001,250.5,true\nR-1002,90,false\n');
  assert.equal(byKind(outputs, 'data').message, 'Saved to My data /Finance/Processed as “Processed invoices” (2 rows, new dataset)');
  assert.equal(byKind(outputs, 'data').rows, 2);

  assert.deepEqual(unsavedOutputs(outputs), []);
  assert.equal(w.approvals.length, 0, 'a My target asks nobody');
  // EVERY call — the look before, the write, the read back — ran as the running user object.
  assert.ok(w.calls.length > 0);
  for (const c of w.calls) assert.equal(c.user, USER, `${c.name} was dispatched as the acting user`);
});

test('a second run adds a new file and a new note, and a new VERSION of the one dataset', async () => {
  const w = world();
  await runAndSave(threeOutputs(), { reader: ROWS, writer: REPORT }, w);
  // The second run produced its result after the first run's rows had landed.
  const { outputs } = await runAndSave(threeOutputs(), { reader: '[{"invoice_no":"R-2001","net_amount":10,"paid":true}]', writer: REPORT }, w, { at: Date.now() + 60_000 });
  assert.equal(w.files.length, 2);
  assert.notEqual(w.files[0].name, w.files[1].name, 'two runs in the same minute still get two names');
  assert.equal(w.notes.length, 2);
  assert.equal(w.datasets.length, 1, 'one dataset per output');
  assert.equal(w.datasets[0].ingests.length, 2);
  assert.match(byKind(outputs, 'data').message, /\(1 row, new version\)/);
});

test('a Domain target is saved in My and the promotion is requested — reported as waiting, never approved', async () => {
  const { w, outputs } = await runAndSave(threeOutputs('domain'), { reader: ROWS, writer: REPORT });
  assert.equal(w.files[0].tier, 'dataset', 'the write lands in the runner\'s own lane');
  assert.equal(w.files[0].folder, '/reports');
  const file = byKind(outputs, 'files');
  assert.equal(file.state, 'saved');
  assert.deepEqual(file.promotion, { state: 'requested', approvalId: w.approvals.find((a) => a.kind === 'file')!.id });
  assert.match(file.message, /^Saved to My files \/reports\/invoice-desk-.*\.md; promotion to Domain files \/reports requested, waiting for a domain admin$/);
  assert.match(byKind(outputs, 'knowledge').message, /^Saved to My knowledge \/results as “Result — .*”; promotion to Domain knowledge \/results requested, waiting for a domain admin$/);
  assert.deepEqual(w.approvals.map((a) => a.kind).sort(), ['file', 'personal_knowledge']);
  assert.deepEqual(w.approvals.map((a) => a.artifactId).sort(), [w.files[0].id, w.notes[0].id].sort());

  // The dataset is saved; its promotion is refused by the governed path's own gate — said as such.
  const data = byKind(outputs, 'data');
  assert.equal(data.state, 'saved');
  assert.equal(data.promotion?.state, 'not_requested');
  assert.match(data.message, /^Saved to My data .*; promotion to Domain data \/Finance\/Processed was not requested: Cannot promote — the dataset has no description/);
  // Nothing in the whole save is an approval or a decision.
  assert.ok(!w.calls.some((c) => /approve|decide|publish|promote_/.test(c.name)));
});

test('a result without a table: Data is not saved and says so; the other outputs are saved', async () => {
  const { w, outputs } = await runAndSave(threeOutputs(), { reader: 'Both invoices look fine.', writer: REPORT });
  const data = byKind(outputs, 'data');
  assert.equal(data.state, 'not_saved');
  assert.equal(data.message, 'Not saved: no table in the result, nothing saved to Data');
  assert.equal(data.retry, undefined, 'saving again cannot help — the result has no table');
  assert.equal(w.datasets.length, 0, 'no dataset is invented');
  assert.ok(!w.calls.some((c) => c.name === 'create_dataset' || c.name === 'ingest_dataset'));
  assert.equal(byKind(outputs, 'files').state, 'saved');
  assert.equal(byKind(outputs, 'knowledge').state, 'saved');
  assert.deepEqual(unsavedOutputs(outputs).map((o) => o.kind), ['data']);
});

test('nothing is written when the producing agent failed', async () => {
  const { w, outputs, team } = await runAndSave(threeOutputs(), { reader: ROWS, writer: new Error('model unavailable') });
  assert.equal(team.failed, true);
  assert.deepEqual(w.writes(), [], 'not one write was dispatched');
  for (const o of outputs) {
    assert.equal(o.state, 'not_saved');
    assert.match(o.message, /^Not saved: the run failed at writer, so nothing was saved$/);
  }
  // The reader DID finish: its rows can be saved by hand. The writer's report cannot.
  assert.equal(byKind(outputs, 'data').retry, 'by-hand');
  assert.equal(byKind(outputs, 'files').retry, undefined);
});

test('a read-only team writes nothing in a run; the person\'s own "Save now" does', async () => {
  const sys = { ...threeOutputs(), safetyPreset: 'read-only' as const };
  const first = await runAndSave(sys, { reader: ROWS, writer: REPORT });
  assert.deepEqual(first.w.writes(), []);
  for (const o of first.outputs) {
    assert.equal(o.state, 'not_saved');
    assert.match(o.message, /this team is read-only, so a run writes nothing by itself/);
    assert.equal(o.retry, 'by-hand');
  }
  const byHand = await saveRunOutputs({ user: USER, system: first.run, systemId: 'sys-inv', runId: first.runId, at: AT, status: 'done', nodes: first.nodes, previous: first.outputs, mode: 'by-hand', ...first.w.door });
  assert.deepEqual(byHand.map((o) => o.state), ['saved', 'saved', 'saved']);
});

test('the save is refused outside the declared folders, and holds no other tool or grant', async () => {
  const w = world();
  const sys = withOutputTools({ ...threeOutputs(), grants: { ...threeOutputs().grants, tools: [...threeOutputs().grants.tools, 'query_data'] } });
  const dispatch = await outputDispatchFor(USER, sys, 'sys-inv', newRun(), w.door);

  const elsewhere = await dispatch('upload_file', { name: 'x.md', folder: '/elsewhere', text: 'x' });
  assert.equal(elsewhere.isError, true);
  assert.match(elsewhere.text, /may not write a file to \/elsewhere: this system writes files only to \/reports \(My files\)/);
  const root = await dispatch('create_dataset', { name: 'Stray' });
  assert.equal(root.isError, true);
  assert.match(root.text, /may not write a dataset to \/: this system writes datasets only to \/Finance\/Processed \(My data\)/);
  const note = await dispatch('save_knowledge_note', { title: 'x', md: 'x', folder: '/private' });
  assert.equal(note.isError, true);
  assert.match(note.text, /may not write a knowledge note to \/private/);
  // A tool the AGENTS hold is not the saver's, and a promotion is not offered for a My target.
  assert.match((await dispatch('query_data', { sql: 'select 1' })).text, /Tool not available/);
  assert.match((await dispatch('request_promotion', { kind: 'file', id: 'as_x' })).text, /Tool not available/);
  assert.deepEqual(w.writes(), [], 'none of the refused calls reached a tool');
  assert.deepEqual(outputSaveSystem(sys).grants.tools.sort(), ['create_dataset', 'get_dataset', 'get_file', 'ingest_dataset', 'list_datasets', 'list_files', 'save_knowledge_note', 'upload_file']);

  // A dataset or file the declared folders do not hold cannot be written through this door.
  w.datasets.push({ id: 'ds_other', name: 'Payroll', folder: '/hr', owner: USER.id, tier: 'dataset', documented: true, bronze: true, ingests: [] });
  const fresh = await outputDispatchFor(USER, sys, 'sys-inv', newRun(), w.door);
  const foreign = await fresh('ingest_dataset', { datasetId: 'ds_other', content: 'a\n1' });
  assert.equal(foreign.isError, true);
  assert.match(foreign.text, /not granted dataset ds_other/);
  assert.deepEqual(w.datasets[0].ingests, []);
});

test('a failed write is retried once it works, and a save that already happened is found, not repeated', async () => {
  const w = world();
  w.failing.set('upload_file', 'object store unreachable');
  const first = await runAndSave(threeOutputs(), { reader: ROWS, writer: REPORT }, w);
  const file = byKind(first.outputs, 'files');
  assert.equal(file.state, 'failed');
  assert.equal(file.message, 'Not saved: object store unreachable');
  assert.equal(file.retry, 'again');
  assert.equal(byKind(first.outputs, 'knowledge').state, 'saved', 'one output failing does not stop the next');

  w.failing.clear();
  const again = { user: USER, system: first.run, systemId: 'sys-inv', runId: first.runId, at: AT, status: 'done' as const, nodes: first.nodes, mode: 'by-hand' as const, ...w.door };
  const second = await saveRunOutputs({ ...again, previous: first.outputs });
  assert.deepEqual(second.map((o) => o.state), ['saved', 'saved', 'saved']);
  assert.equal(w.files.length, 1);
  // Pressing it again — and even with the ledger LOST — writes nothing a second time.
  const third = await saveRunOutputs({ ...again, previous: second });
  const fourth = await saveRunOutputs({ ...again, previous: undefined });
  assert.equal(w.files.length, 1, 'one file');
  assert.equal(w.notes.length, 1, 'one note');
  assert.equal(w.datasets.length, 1, 'one dataset');
  assert.equal(byKind(third, 'files').id, w.files[0].id);
  assert.equal(byKind(fourth, 'files').id, w.files[0].id, 'found by the run tag in its name');
  assert.equal(byKind(fourth, 'knowledge').id, w.notes[0].id, 'found by the save key');
  assert.equal(w.datasets[0].ingests.length, 1, 'the rows landed once: a Bronze built after the run’s result is this run’s');
  assert.equal(w.calls.filter((c) => c.name === 'upload_file').length, 2, 'one refused upload, then exactly one that wrote');
  assert.equal(w.files[0].name, outputFileName(first.run, first.run.outputs![0], first.runId, AT));
});

test('a crash between landing the rows and recording it: the resumed save finds them and lands nothing again; an older run never overwrites newer rows', async () => {
  const w = world();
  const first = await runAndSave(threeOutputs(), { reader: ROWS, writer: REPORT }, w, { at: Date.now() - 1_000 });
  assert.equal(w.datasets[0].ingests.length, 1);
  // The ledger was lost (the process died before it was written): the same run saves again.
  const resumed = await saveRunOutputs({ user: USER, system: first.run, systemId: 'sys-inv', runId: first.runId, at: Date.now() - 1_000, status: 'done', nodes: first.nodes, ...w.door });
  assert.deepEqual(resumed.map((o) => o.state), ['saved', 'saved', 'saved']);
  assert.equal(w.datasets[0].ingests.length, 1, 'no second landing');
  assert.equal(w.files.length, 1);
  assert.equal(w.notes.length, 1);
  assert.match(byKind(resumed, 'data').message, /\(2 rows, already landed\)$/);
  // A run whose result is OLDER than the rows now in the dataset does not replace them.
  const older = await runAndSave(threeOutputs(), { reader: '[{"invoice_no":"OLD","net_amount":1,"paid":false}]', writer: REPORT }, w, { at: Date.now() - 3_600_000 });
  assert.equal(byKind(older.outputs, 'data').state, 'saved');
  assert.equal(w.datasets[0].ingests.length, 1, 'the newer rows stay');
});

// ---------------------------------------------------------- run service ----

async function storedSystem(sys: System) {
  __resetStore();
  const id = createSystem(USER, { name: 'Invoice Desk', domain: 'finance', yaml: serializeSystem(sys) }).id;
  // A built system: a run needs the system's own model key (executeTeamRun refuses without one).
  const keys = memorySystemKeyStore();
  __setSystemKeyStoreForTests(keys);
  const caps = { models: ['m'], maxBudget: 5, budgetDuration: '7d', rpmLimit: 1, tpmLimit: 1, maxParallelRequests: 1 };
  await keys.put(sealSystemKey({ systemId: id, alias: systemKeyAlias(id), key: mintSystemKey(), caps, createdAt: 1, rotatedAt: null }, deploymentKek()));
  return id;
}

async function execute(id: string, w: ReturnType<typeof world>, answers: Record<string, string | Error>, runId: string, resume = false) {
  const view = getSystemForRun(id, USER);
  const yaml = serializeSystem(withOutputTools(view.system));
  const events: { event: string; data: unknown }[] = [];
  const body = await executeTeamRun({
    user: USER, systemId: id, view, yaml, runId, resume,
    messages: [{ role: 'user', content: 'Process the invoices.' }],
    emit: (event, data) => events.push({ event, data }),
    outputDoor: w.door,
    runTeam: (i) => runOsTeam({ ...i, llm: scripted(answers), toolDeps: w.toolDeps }),
  });
  return { body, events, lastRun: getSystemForRun(id, USER).lastRun! };
}

test('executeTeamRun: the report is on record before the save, and the finished run lists every output', async () => {
  const id = await storedSystem(threeOutputs());
  const w = world();
  const runId = newRun();
  const { body, events, lastRun } = await execute(id, w, { reader: ROWS, writer: REPORT }, runId);
  assert.equal(body.status, 'done');
  assert.equal(body.completedWithUnsavedOutputs, false);
  assert.deepEqual(body.outputs!.map((o) => `${o.kind}:${o.state}`), ['files:saved', 'knowledge:saved', 'data:saved']);
  assert.deepEqual(lastRun.outputs, body.outputs, 'the stored last run carries the same list (Define and get_agent_run read it)');
  // `outputs-saving` (every output pending) is emitted before `done`.
  const order = events.map((e) => e.event).filter((e) => e === 'outputs-saving' || e === 'done');
  assert.deepEqual(order, ['outputs-saving', 'done']);
  const saving = events.find((e) => e.event === 'outputs-saving')!.data as { outputs: OutputResult[] };
  assert.deepEqual(saving.outputs.map((o) => o.state), ['pending', 'pending', 'pending']);
  for (const c of w.calls) assert.equal(c.user.id, 'alex');
});

test('executeTeamRun: a save that fails does not fail the run — it is "completed with unsaved outputs", visibly', async () => {
  const id = await storedSystem(threeOutputs());
  const w = world();
  w.failing.set('save_knowledge_note', 'knowledge store unreachable');
  const { body, lastRun } = await execute(id, w, { reader: ROWS, writer: REPORT }, newRun());
  assert.equal(body.status, 'done', 'the analysis stands');
  assert.equal(body.ok, true);
  assert.equal(body.completedWithUnsavedOutputs, true);
  assert.match(body.finalText, /Invoice report/);
  const line = 'Completed with unsaved outputs — “Result”: knowledge store unreachable';
  assert.ok(body.warnings!.includes(line));
  assert.ok(lastRun.warnings!.includes(line), 'the stored run carries the warning');
  assert.equal(lastRun.outputs!.find((o) => o.kind === 'knowledge')!.retry, 'again');
});

test('executeTeamRun: resuming a run that finished but died before its save was recorded saves nothing twice', async () => {
  const id = await storedSystem(threeOutputs());
  const w = world();
  const runId = newRun();
  const first = await execute(id, w, { reader: ROWS, writer: REPORT }, runId);
  assert.equal(first.body.status, 'done');
  // THE CRASH WINDOW: everything was written, but the record still says `pending`.
  setLastRun(id, USER, { ...first.lastRun, outputs: first.lastRun.outputs!.map((o) => ({ key: o.key, index: o.index, kind: o.kind, name: o.name, target: o.target, state: 'pending' as const, retry: 'again' as const, message: 'Saving…' })) });

  const resumed = await execute(id, w, { reader: new Error('the model must not be called again'), writer: new Error('the model must not be called again') }, runId, true);
  assert.equal(resumed.body.status, 'done');
  assert.deepEqual(resumed.body.outputs!.map((o) => o.state), ['saved', 'saved', 'saved']);
  assert.equal(w.files.length, 1, 'no second file');
  assert.equal(w.notes.length, 1, 'no second note');
  assert.equal(w.datasets.length, 1, 'no second dataset');
  assert.equal(w.calls.filter((c) => c.name === 'upload_file').length, 1);
  assert.equal(w.calls.filter((c) => c.name === 'create_dataset').length, 1);
  assert.equal(w.calls.filter((c) => c.name === 'ingest_dataset').length, 1, 'the rows are not landed a second time');
  assert.equal(w.datasets[0].ingests.length, 1);
  assert.equal(resumed.body.outputs!.find((o) => o.kind === 'files')!.id, w.files[0].id);
  assert.deepEqual(resumed.lastRun.outputs!.map((o) => o.state), ['saved', 'saved', 'saved']);

  // Once the save IS recorded, a further resume is the conflict it always was.
  await assert.rejects(() => execute(id, w, { reader: ROWS, writer: REPORT }, runId, true), /already finished/);
});

// Prod, 21 Nov 2026: a runner whose FIRST domain is not the system's domain got the note and the
// dataset filed in that first domain (the tools' default) — the note "saved" where nobody looked,
// and the rows then failed "Dataset not found". The saver names the system's own domain.
test('outputs are filed in the agent system\'s domain, not the runner\'s first domain', async () => {
  const { w } = await runAndSave(threeOutputs(), { reader: `Here are the rows:\n\n${ROWS}`, writer: REPORT });
  const note = w.calls.find((c) => c.name === 'save_knowledge_note')!;
  const made = w.calls.find((c) => c.name === 'create_dataset')!;
  assert.equal((note.args as Record<string, unknown>).domain, 'finance');
  assert.equal((made.args as Record<string, unknown>).domain, 'finance');
  const file = w.calls.find((c) => c.name === 'upload_file')!;
  assert.equal((file.args as Record<string, unknown>).domain, 'finance');
});

test('a runner outside the system\'s domain gets every output refused with the reason — nothing is filed elsewhere', async () => {
  const outsider: CurrentUser = { ...USER, id: 'olga', domains: ['sales'], allDomains: ['sales'] };
  const w = world();
  const run = withOutputTools(threeOutputs());
  const outputs = await saveRunOutputs({
    user: outsider, system: run, systemId: 'sys-inv', runId: newRun(), at: AT, status: 'done',
    nodes: [{ node: 'reader', status: 'ok', finalText: `rows:\n\n${ROWS}` }, { node: 'writer', status: 'ok', finalText: REPORT }], ...w.door,
  });
  assert.equal(outputs.length, 3);
  for (const o of outputs) {
    assert.equal(o.state, 'not_saved');
    assert.match(o.reason ?? '', /not a member of the domain “finance”/);
  }
  assert.deepEqual(w.writes(), [], 'not one write was dispatched');
});

test('WF/K: a declared KNOWLEDGE output is saved with the note tool only — the saver is never offered a workflow tool', () => {
  const base = addOutput(team(), { kind: 'knowledge', name: 'Result', folder: { path: '/results', scope: 'personal' } });
  const sys: System = {
    ...base,
    grants: { ...base.grants, tools: [...base.grants.tools, 'author_workflow', 'search_knowledge'], workflows: [{ id: 'wf_a', capability: 'Write-bounded' }] },
  };
  const saver = outputSaveSystem(sys);
  assert.deepEqual(saver.grants.tools, ['save_knowledge_note']);
  assert.deepEqual(saver.grants.workflows, [], 'the system’s workflow grants are dropped from the save scope');
  assert.ok(saver.grants.knowledge.length > 0 && saver.grants.knowledge.every((g) => g.folder), 'only the declared folder is granted');
});
