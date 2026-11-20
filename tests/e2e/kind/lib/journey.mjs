/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       acceptance harness (tests/e2e/kind)
 * FEATURE:    Journeys, assertions, negative twins and the expected-fail (red-first) marker
 * USER STORY: As the programme gate (WP-48) I want every acceptance assertion and every negative
 *             twin to exist and run before the work it proves, red with a named reason per hop,
 *             and I want an assertion that turns green to fail the run until its marker is removed.
 * ARCHITECTURE:
 *   - journey(id) returns {step, assertion, twin}. Steps are memoised actions (upload, run, approve)
 *     shared by the journey's assertions; a failed step makes every assertion that needs it red
 *     with that step's reason.
 *   - assertion(id, meta, fn): fn reads a COMPONENT record and throws when it does not show what
 *     the design requires. meta.expectedFail names the WP that will make it green.
 *       expected-fail + fn throws  -> node test passes, report status `red` with the reason;
 *       expected-fail + fn passes  -> node test FAILS (`unexpected-green`): remove the marker;
 *       no marker                  -> ordinary test (`green` or `failed`).
 *     E2E_IGNORE_XFAIL=1 drops every marker (what WP-48 runs).
 *   - twin(id, meta, {check, disable, restore}): the negative twin. It is meaningful only when the
 *     positive check is green first; then it disables one hop and the check MUST turn red. A twin
 *     that stays green means the test cannot see the hop, and fails the run. meta.expect='green'
 *     marks the one twin that must stay green (AT-a, F3: claim before grant propagation);
 *     meta.redReasonMust (RegExp) additionally requires the red to carry a specific typed reason
 *     (AT-b: "metric-compile unreachable" must be a typed reason, never "no data").
 *   - Every outcome is appended to $E2E_REPORT_DIR/results.jsonl for render-report.mjs.
 */
import { test, after } from 'node:test';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { HopError } from './hop.mjs';
import { closeForwards } from './kube.mjs';

const REPORT_DIR = process.env.E2E_REPORT_DIR ?? join(process.cwd(), 'report');
const IGNORE_XFAIL = process.env.E2E_IGNORE_XFAIL === '1';
const TIMEOUT = Number(process.env.E2E_ASSERT_TIMEOUT_MS ?? 15 * 60 * 1000);
mkdirSync(REPORT_DIR, { recursive: true });
// Port-forward children keep the event loop alive; end them when the file's tests are done.
after(() => closeForwards());

function record(entry) {
  appendFileSync(join(REPORT_DIR, 'results.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

function reasonOf(err) {
  if (err instanceof HopError) return { component: err.component, hop: err.hop, reason: err.reason, closedBy: err.wp };
  return { component: null, hop: null, reason: String(err?.message ?? err).split('\n')[0] };
}

/** Plain assertion failure about a record that WAS read but says the wrong thing. */
export class RecordMismatch extends Error {
  constructor(component, what, got) {
    super(`[${component}] ${what}; record shows ${typeof got === 'string' ? got : JSON.stringify(got)?.slice(0, 300)}`);
    this.name = 'RecordMismatch';
  }
}

export function check(cond, component, what, got) {
  if (!cond) throw new RecordMismatch(component, what, got);
}

export function journey(journeyId, title) {
  const steps = new Map();

  function step(name, fn) {
    if (!steps.has(name)) {
      const p = (async () => fn())();
      p.catch(() => {});
      steps.set(name, p);
    }
    return steps.get(name).catch((err) => {
      const r = reasonOf(err);
      throw new HopError({ component: r.component ?? 'journey', hop: `step "${name}" → ${r.hop ?? ''}`.trim(), reason: r.reason, wp: r.closedBy });
    });
  }

  function assertion(id, meta, fn) {
    const label = `${journeyId} ${id} — ${meta.hop}`;
    test(label, { timeout: TIMEOUT }, async () => {
      const t0 = Date.now();
      const base = { journey: journeyId, title, kind: 'assertion', id, hop: meta.hop, record: meta.record, expectedFail: IGNORE_XFAIL ? null : meta.expectedFail ?? null };
      try {
        await fn();
      } catch (err) {
        const r = reasonOf(err);
        if (base.expectedFail) { record({ ...base, status: 'red', ...r, ms: Date.now() - t0 }); return; }
        record({ ...base, status: 'failed', ...r, ms: Date.now() - t0 });
        throw err;
      }
      if (base.expectedFail) {
        record({ ...base, status: 'unexpected-green', ms: Date.now() - t0 });
        throw new Error(`${label} is GREEN but marked expected-fail (${base.expectedFail}): remove the marker`);
      }
      record({ ...base, status: 'green', ms: Date.now() - t0 });
    });
  }

  function twin(id, meta, { check: positive, disable, restore }) {
    const label = `${journeyId} ${id} — twin: ${meta.disables}`;
    test(label, { timeout: TIMEOUT }, async () => {
      const t0 = Date.now();
      const expect = meta.expect ?? 'red';
      const base = { journey: journeyId, title, kind: 'twin', id, hop: meta.disables, record: meta.record, mustBe: expect, expectedFail: IGNORE_XFAIL ? null : meta.expectedFail ?? null };
      const verdict = async () => {
        try { await positive(); } catch (err) {
          throw new HopError({ component: reasonOf(err).component ?? 'journey', hop: 'precondition', reason: `positive check is red, so the twin cannot be evaluated: ${reasonOf(err).reason}` });
        }
        await disable();
        let stayedGreen = true;
        let redReason = null;
        try { await positive(); } catch (err) { stayedGreen = false; redReason = reasonOf(err).reason; }
        finally { await restore?.(); }
        if (expect === 'red' && stayedGreen) throw new Error(`twin stayed GREEN with "${meta.disables}" disabled: the test cannot see this hop`);
        if (expect === 'red' && meta.redReasonMust && !meta.redReasonMust.test(redReason)) {
          throw new Error(`twin went red for the wrong reason (must match ${meta.redReasonMust}): ${redReason}`);
        }
        if (expect === 'green' && !stayedGreen) throw new Error(`must stay green with "${meta.disables}", turned red: ${redReason}`);
        return redReason;
      };
      let redReason;
      try {
        redReason = await verdict();
      } catch (err) {
        const r = reasonOf(err);
        if (base.expectedFail) { record({ ...base, status: 'red', ...r, ms: Date.now() - t0 }); return; }
        record({ ...base, status: 'failed', ...r, ms: Date.now() - t0 });
        throw err;
      }
      if (base.expectedFail) {
        record({ ...base, status: 'unexpected-green', ms: Date.now() - t0 });
        throw new Error(`${label} now behaves as designed but is marked expected-fail (${base.expectedFail}): remove the marker`);
      }
      record({ ...base, status: 'green', twinRedReason: redReason, ms: Date.now() - t0 });
    });
  }

  return { step, assertion, twin };
}
