/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The bulk Promote path may never discard the server's reason again
 * USER STORY: As the maintainer who spent an evening on "0 requested · 1 failed", I want CI to
 *             refuse the next edit that counts `res.ok` and drops the 400 body — the exact
 *             regression, not a paraphrase of it.
 * ARCHITECTURE:
 *   - A test cannot IMPORT a `.tsx` (Node strips types, not JSX → ERR_UNKNOWN_FILE_EXTENSION),
 *     so both components are read as TEXT and asserted on their source.
 *   - What this grep DOES guarantee: inside `bulkPromote`'s own body the response body is
 *     parsed, the text reaches `serverError`, the notice comes from `summariseBulk`, and no
 *     `if (res.ok)` branch decides the outcome. What it does NOT guarantee: that some third
 *     caller elsewhere formats its own notice by hand. A new bulk action must route through
 *     `@tabs/files/lib/bulk-result` or be added here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OSUI = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const BROWSER = 'tabs/files/ui/FilesBrowser.tsx';
const PREVIEW = 'tabs/files/ui/FilePreview.tsx';

function src(path: string): string {
  return readFileSync(resolve(OSUI, path), 'utf8');
}

/** The body of one `const <name> = useCallback(` … `}, [` declaration. */
function callbackBody(source: string, name: string): string {
  const start = source.indexOf(`const ${name} = useCallback(`);
  assert.ok(start > 0, `${name} not found — rename it here too`);
  const end = source.indexOf('}, [', start);
  assert.ok(end > start, `${name}'s dependency array not found`);
  return source.slice(start, end);
}

test('bulkPromote READS the response body and routes it through the shared formatter', () => {
  const body = callbackBody(src(BROWSER), 'bulkPromote');
  // The regression itself: the JSON body must be parsed per file…
  assert.match(body, /res\.json\(\)/, 'bulkPromote must read the response body');
  // …and its `error` text must reach the shared helper, not a counter.
  assert.match(body, /serverError\(/, 'bulkPromote must read the server error via serverError()');
  assert.match(body, /summariseBulk\(/, 'the notice must come from summariseBulk, not a template literal');
  // The STRUCTURAL form of the defect: `res.ok` decided the outcome before — in fact
  // instead of — reading the body. Whatever the branch looks like, the parse comes first.
  assert.ok(
    body.indexOf('res.json()') < body.indexOf('res.ok'),
    'the response body must be read BEFORE res.ok decides the outcome',
  );
  assert.ok(!/failed \+= 1/.test(body), 'count failures as outcomes carrying their reason, not a tally');
  assert.ok(!/requested \+= 1/.test(body), 'a tally cannot carry a reason — push a BulkOutcome');
});

test('the notice no longer hard-codes the approval sentence next to a count', () => {
  const body = callbackBody(src(BROWSER), 'bulkPromote');
  // The sentence may be PASSED to the formatter (which suppresses it when nothing was
  // filed) but must never be concatenated onto a count in the component.
  assert.match(body, /approvalNote: 'A domain admin approves each\.'/, 'the approval sentence must go through summariseBulk');
  assert.equal(
    body.match(/A domain admin/g)?.length, 1,
    'the component mentions the approval more than once — summariseBulk owns the grammar',
  );
  assert.ok(
    !/\$\{requested\}|\$\{failed\}/.test(body),
    'the component is formatting its own count again — summariseBulk owns the grammar',
  );
});

test('the browser imports the shared formatter and the shared gate', () => {
  const source = src(BROWSER);
  assert.match(source, /from '@tabs\/files\/lib\/bulk-result'/);
  assert.match(source, /from '@tabs\/files\/lib\/bulk-docs'/);
  // The pre-flight uses the SAME gate module the server does — never a local copy. A
  // component that decided readiness itself would drift from the store on its first edit.
  assert.match(source, /from '@tabs\/files\/lib\/promotion'/);
  assert.match(source, /promotionReadiness\(/, 'the pre-flight must call the shared gate');
  assert.ok(
    !/missing\.push\(/.test(source),
    'the gate rule is being rebuilt in the component — promotion.ts owns `missing`',
  );
});

/**
 * REVIEW M2 — the defect was not specific to Promote. `bulkArchive` tallied `res.ok` the same
 * way, and the bulk move kept only the LAST `setErr`, so eleven of twelve refusals vanished.
 * All four bulk actions are held to the one rule, and a fifth must join this list.
 */
const BULK_ACTIONS = ['bulkPromote', 'bulkDescribeAndTag', 'bulkArchive', 'moveInto'];

test('EVERY bulk action reads the body and reports through the shared formatter', () => {
  const source = src(BROWSER);
  for (const name of BULK_ACTIONS) {
    const body = callbackBody(source, name);
    assert.match(body, /res\.json\(\)/, `${name} must read the response body`);
    assert.match(body, /serverError\(/, `${name} must carry the server's own text`);
    assert.match(body, /summariseBulk\(/, `${name} must report through summariseBulk`);
    assert.ok(
      body.indexOf('res.json()') < body.indexOf('res.ok'),
      `${name}: the body must be read BEFORE res.ok decides the outcome`,
    );
    // A tally of the ACTION cannot carry a reason. (A `skipped` counter may: a skip has no
    // server response to quote.)
    assert.ok(
      !/(failed|requested|archived|moved|updated) \+= 1/.test(body),
      `${name}: count outcomes carrying their reason, not a tally`,
    );
    // The last writer wins — which is how the bulk move lost eleven of twelve reasons.
    assert.ok(
      !/setErr\(\(await res\.json\(\)\)/.test(body),
      `${name}: a per-file failure must become an outcome, not overwrite one error strip`,
    );
  }
});

test('a 200 that filed nothing is not counted as a request (already: true)', () => {
  const body = callbackBody(src(BROWSER), 'bulkPromote');
  assert.match(body, /data\.already/, 'the route answers an existing request with { already: true }');
  assert.match(body, /already:/, 'it must reach summariseBulk as its own outcome, not as ok');
});

/**
 * PR #61 gives a domain_admin/admin OWNER a ONE-SHOT promotion:
 * `{ promoted: true, requested: false, … }`. Read as a bare 200 it would report "12
 * requested" for twelve files that are already IN the domain — a third spelling of the
 * original defect, so the branch is pinned here.
 */
test('the owner-approver’s one shot is read as promoted, not as a filed request', () => {
  const body = callbackBody(src(BROWSER), 'bulkPromote');
  assert.match(body, /data\.promoted/, 'bulkPromote must branch on the route’s `promoted` flag');
  assert.match(body, /promoted:/, 'it must reach summariseBulk as its own outcome');
  // The three shapes are mutually exclusive, so the classification must not treat a promoted
  // response as an already-pending one.
  assert.ok(
    body.indexOf('data.promoted') < body.indexOf('data.already'),
    'classify the one-shot first — `promoted: true` carries `requested: false`',
  );
});

test('the single-file path announces the one shot instead of an approval', () => {
  const body = callbackBody(src(PREVIEW), 'requestPromote');
  assert.match(body, /data\.promoted/, 'FilePreview must branch on the one-shot too');
  assert.match(body, /Promoted to the domain/, 'the owner-approver needs the outcome, not a wait');
});

test('no bulk notice is hand-formatted any more — summariseBulk owns every one', () => {
  const source = src(BROWSER);
  // The two whole-selection refusals used to be built by hand (review L2).
  assert.ok(!/Nothing to promote/.test(source), 'the empty-selection notice must come from summariseBulk');
  assert.ok(!/Nothing to archive/.test(source), 'the empty-selection notice must come from summariseBulk');
  // Every setBulkNotice call must be fed by the formatter.
  const calls = source.match(/setBulkNotice\([^)]*/g) ?? [];
  for (const call of calls) {
    const ok = call.includes('summariseBulk') || call.includes("''");
    assert.ok(ok, `a hand-formatted notice is back: ${call}`);
  }
});

test('the Describe & tag dialog tells the admin which tiers it is about to relabel', () => {
  const source = src(BROWSER);
  assert.match(source, /tierBreakdown\(/, 'the dialog must show the selection’s tier breakdown (review L1)');
});

test('bulkDescribeAndTag reports per file and writes through the EXISTING per-file route', () => {
  const body = callbackBody(src(BROWSER), 'bulkDescribeAndTag');
  assert.match(body, /describeAndTagPatch\(/, 'the patch semantics live in the tested lib');
  assert.match(body, /summariseBulk\(/, 'same per-file reporting as Promote');
  assert.match(body, /serverError\(/);
  assert.match(body, /method: 'PATCH'/, 'must reuse PATCH /api/files/[id] — no new write path');
  assert.ok(!/\/docs/.test(body), 'a new write endpoint appeared — reuse the per-file route');
  assert.ok(
    body.indexOf('res.json()') < body.indexOf('res.ok'),
    'the response body must be read BEFORE res.ok decides the outcome',
  );
});

test('the single-file path still shows the server error, through the same helper', () => {
  const body = callbackBody(src(PREVIEW), 'requestPromote');
  assert.match(body, /res\.json\(\)/);
  assert.match(body, /serverError\(/, 'FilePreview must share the formatter, not its own ?? chain');
  assert.match(src(PREVIEW), /from '@tabs\/files\/lib\/bulk-result'/);
});
