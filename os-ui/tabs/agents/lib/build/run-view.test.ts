/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The Run panel shows one run at a time, and says which
 * USER STORY: As a builder I press Run and the previous result is gone before the first event; the
 *             result I then see is labelled as this run; a stored run is labelled "Last run"; and
 *             a second panel on the same screen never keeps an older run next to the new one.
 * ARCHITECTURE: The pure state the panel keeps (`build/run-view.ts`). A test must not import a
 *             `.tsx`, which is why the decision lives outside it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { announceRunStarted, onRunStartedElsewhere, runLabel, runLabelParts, runViewReducer, seedRunView, shortRunId, type RunViewState } from '@tabs/agents/lib/build/run-view';
import { catalogText, hasCatalogKey, CATALOG_LOCALES } from '@core/testing/catalog-text';

type Run = { runId?: string; at?: number; startedAt?: number; steps: string[]; output?: string; failed?: boolean; warnings?: string[]; contextFiles: string[] };

const RUN_1: Run = { runId: 'run_11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', startedAt: 1_000, at: 2_000, steps: Array(13).fill('get_file'), output: 'PDF text extraction failed', contextFiles: Array(12).fill('f'), failed: true, warnings: ['w'] };
const RUN_2: Run = { runId: 'run_22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb', startedAt: 9_000, at: 9_500, steps: ['list_files', 'list_files', 'upload_file'], output: 'No invoices exist.', contextFiles: [] };

const reduce = runViewReducer<Run>;
const fmt = (ms: number) => `t${ms}`;

test('page load: a stored run is shown as "Last run", with its start time and short id', () => {
  const view = seedRunView<Run>(RUN_1);
  assert.equal(view.source, 'stored');
  assert.equal(runLabel(view, fmt), 'Last run · started t1000 · run 11111111');
  assert.equal(runLabel(seedRunView<Run>({ ...RUN_1, startedAt: undefined }), fmt), 'Last run · finished t2000 · run 11111111');
  assert.equal(runLabel(seedRunView<Run>({ steps: [], contextFiles: [], at: 5 }), fmt), 'Last run · finished t5', 'a run recorded without an id still says when');
  assert.equal(runLabel(seedRunView<Run>(null), fmt), '', 'nothing shown, nothing labelled');
});

test('the run followed here is "This run", never "Last run"', () => {
  let view = reduce(seedRunView<Run>(RUN_1), { type: 'started', at: 9_000 });
  view = reduce(view, { type: 'result', run: { ...RUN_2, startedAt: undefined, at: undefined }, at: 9_600 });
  assert.equal(view.source, 'live');
  assert.equal(runLabel(view, fmt), 'This run · started t9000 · run 22222222');
});

test('pressing Run clears every per-run element before the first event arrives', () => {
  const before = seedRunView<Run>(RUN_1);
  const started = reduce(before, { type: 'started', at: 9_000 });
  // Result text, context card, counters, warnings and the failure banner all read `run`.
  assert.equal(started.run, null);
  assert.equal(started.source, null);
  assert.equal(started.at, null);
  assert.equal(started.startedAt, 9_000);
  assert.equal(runLabel(started, fmt), '');
});

test('REPRODUCTION (second panel): mounted with run 1, it shows run 2 once run 2 is the stored latest', () => {
  // The Evaluate half mounted while run 1 was the stored run; the Run half then ran run 2 and the
  // page reloaded its data. Before the fix this panel kept run 1 for as long as it stayed mounted.
  const mounted = seedRunView<Run>(RUN_1);
  const after = reduce(mounted, { type: 'stored', run: RUN_2, busy: false });
  assert.equal(after.run, RUN_2);
  assert.equal(after.run?.steps.length, 3);
  assert.deepEqual(after.run?.contextFiles, []);
  assert.equal(after.run?.output, 'No invoices exist.');
  assert.equal(after.run?.failed, undefined);
  assert.equal(runLabel(after, fmt), 'Last run · started t9000 · run 22222222');
});

test('an OLDER stored run never replaces the live result on screen', () => {
  let view = reduce(seedRunView<Run>(RUN_1), { type: 'started', at: 9_000 });
  view = reduce(view, { type: 'result', run: RUN_2, at: 9_600 });
  // The reload after the run still answers with run 1 (the stale record): it must not come back.
  const after = reduce(view, { type: 'stored', run: RUN_1, busy: false });
  assert.equal(after, view);
  assert.equal(after.run?.runId, RUN_2.runId);
});

test('the stored copy of the SAME run does not relabel the live result', () => {
  let view = reduce(seedRunView<Run>(null), { type: 'started', at: 9_000 });
  view = reduce(view, { type: 'result', run: RUN_2, at: 9_600 });
  const after = reduce(view, { type: 'stored', run: { ...RUN_2 }, busy: false });
  assert.equal(after, view);
  assert.equal(after.source, 'live');
});

test('a NEWER stored run (started elsewhere) replaces an earlier live result', () => {
  let view = reduce(seedRunView<Run>(null), { type: 'started', at: 1_000 });
  view = reduce(view, { type: 'result', run: RUN_1, at: 2_000 });
  const after = reduce(view, { type: 'stored', run: RUN_2, busy: false });
  assert.equal(after.run?.runId, RUN_2.runId);
  assert.equal(after.source, 'stored');
});

test('an in-flight run is not mixed with a stored one: stored data is ignored until the run is over', () => {
  const started = reduce(seedRunView<Run>(RUN_1), { type: 'started', at: 9_000 });
  const during = reduce(started, { type: 'stored', run: RUN_1, busy: true });
  assert.equal(during, started);
  assert.equal(during.run, null, 'run 1 does not reappear under the progress of run 2');
  // Watching a parked stored run finish: the stored copy must not overwrite it mid-stream either.
  const watching = seedRunView<Run>(RUN_1);
  assert.equal(reduce(watching, { type: 'stored', run: RUN_2, busy: true }), watching);
});

test('the server reporting no stored run clears a stored view but never a live result', () => {
  assert.equal(reduce(seedRunView<Run>(RUN_1), { type: 'stored', run: null, busy: false }).run, null);
  let live: RunViewState<Run> = reduce(seedRunView<Run>(null), { type: 'started', at: 9_000 });
  live = reduce(live, { type: 'result', run: RUN_2, at: 9_600 });
  assert.equal(reduce(live, { type: 'stored', run: null, busy: false }), live);
});

test('watching a stored parked run to its end keeps the time it started', () => {
  const parked = seedRunView<Run>(RUN_1);
  const done = reduce(parked, { type: 'result', run: { ...RUN_1, output: 'finished' }, at: 5_000 });
  assert.equal(done.source, 'live');
  assert.equal(done.startedAt, 1_000);
  assert.equal(runLabel(done, fmt), 'This run · started t1000 · run 11111111');
});

test('short run id: the first eight characters after the prefix', () => {
  assert.equal(shortRunId('run_1b4e28ba-2fa1-11d2-883f-0016d3cca427'), '1b4e28ba');
  assert.equal(shortRunId('legacy-id'), 'legacy-i');
  assert.equal(shortRunId(undefined), '');
});

test('a run started in ONE panel empties the other panels of the same system at once', () => {
  // Run half (a) and Evaluate half (b) of one system, plus a panel of another system (c).
  const a = {}, b = {}, c = {};
  let viewB = seedRunView<Run>(RUN_1);
  let viewC = seedRunView<Run>(RUN_1);
  let toldA = 0;
  const offA = onRunStartedElsewhere('sys-inv', a, () => { toldA += 1; });
  const offB = onRunStartedElsewhere('sys-inv', b, () => { viewB = reduce(viewB, { type: 'cleared' }); });
  const offC = onRunStartedElsewhere('sys-other', c, () => { viewC = reduce(viewC, { type: 'cleared' }); });
  try {
    announceRunStarted('sys-inv', a);
    assert.equal(viewB.run, null, 'the context card and counters of run 1 are gone before any event');
    assert.equal(runLabel(viewB, fmt), '');
    assert.equal(toldA, 0, 'the panel that started the run is not told about its own run');
    assert.equal(viewC.run, RUN_1, 'another system is untouched');
    // The reload after the run hands the emptied panel the new stored run.
    viewB = reduce(viewB, { type: 'stored', run: RUN_2, busy: false });
    assert.equal(viewB.run?.steps.length, 3);
  } finally {
    offA(); offB(); offC();
  }
  let late = 0;
  const off = onRunStartedElsewhere('sys-inv', b, () => { late += 1; });
  off();
  announceRunStarted('sys-inv', a);
  assert.equal(late, 0, 'an unmounted panel is no longer told');
});

test('patched: a later save of the outputs updates the SHOWN run only — never another run on screen', () => {
  type WithOutputs = Run & { outputs?: string[] };
  const r = runViewReducer<WithOutputs>;
  const shown = seedRunView<WithOutputs>({ ...RUN_2, outputs: ['failed'] });
  const same = r(shown, { type: 'patched', runId: RUN_2.runId, patch: { outputs: ['saved'] } });
  assert.deepEqual(same.run?.outputs, ['saved']);
  assert.equal(same.source, 'stored', 'the label does not change');
  const other = r(shown, { type: 'patched', runId: RUN_1.runId, patch: { outputs: ['saved'] } });
  assert.equal(other, shown, 'a save of ANOTHER run changes nothing here');
  const empty = seedRunView<WithOutputs>(null);
  assert.equal(r(empty, { type: 'patched', runId: RUN_2.runId, patch: { outputs: ['saved'] } }), empty);
});

// ---------------------------------------------------------------- i18n --

/** The parts rendered through a locale's catalog and joined the way the panel joins them. */
const labelIn = (view: Parameters<typeof runLabelParts>[0], locale = 'en') =>
  runLabelParts(view, fmt).map((p) => catalogText('agents', p, locale)).join(' · ');

test('i18n: the label rendered through the English catalog is exactly the English runLabel', () => {
  const live = reduce(reduce(seedRunView<Run>(null), { type: 'started', at: 9_000 }), { type: 'result', run: RUN_2, at: 9_500 });
  const views = [
    seedRunView<Run>(RUN_1),
    seedRunView<Run>({ ...RUN_1, startedAt: undefined }),
    seedRunView<Run>({ steps: [], contextFiles: [], at: 5 }),
    seedRunView<Run>(null),
    live,
  ];
  for (const v of views) assert.equal(labelIn(v), runLabel(v, fmt));
  assert.equal(labelIn(live), 'This run · started t9000 · run 22222222');
});

test('i18n: every label key exists in all seven languages', () => {
  const keys = ['run.label.thisRun', 'run.label.lastRun', 'run.label.started', 'run.label.finished', 'run.label.id'];
  for (const locale of CATALOG_LOCALES) {
    for (const k of keys) assert.ok(hasCatalogKey('agents', k, locale), `${locale}: ${k}`);
    assert.ok(labelIn(seedRunView<Run>(RUN_1), locale).includes('11111111'), `${locale} keeps the run id`);
  }
});
