/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Every change of who can see a dataset is versioned and audited
 * USER STORY: As an auditor I want a dataset's tier / visibility / grants change — by promotion,
 *             unshare, certify, decertify, import or a domain move, from any door — to leave a
 *             `governance.audience.change` audit event and a definition-history version (the
 *             domain-repo commit, WP-37) that names the change; and a yaml edit must not be able to
 *             change it at all (incident 2026-11-23, ds_ac4aea92…: private → domain, no trace).
 * ARCHITECTURE:
 *   - One test per writer, each asserting the audit entry AND the project-change event (the commit
 *     hook's input) naming the before → after.
 *   - Ratchets: (1) a source scan — any store function that assigns tier/visibility/grants must
 *     write through `persist` (the choke point), and the set of functions that write `rec.yaml`
 *     directly is pinned; (2) the dbt meta carries visibility + grantees so the commit is never
 *     empty for an audience-only change.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  __resetStore,
  createDataset,
  buildVersion,
  setDocs,
  requestPromotion,
  applyApprovedPromotion,
  certify,
  importProduct,
  transition,
  readFile,
  writeFile,
  getDataset,
  type Principal,
} from '@tabs/data/lib/store';
import { DatasetError } from '@tabs/data/lib/dataset-schema';
import { onProjectChange, type ProjectChange } from '@tabs/data/lib/project-events';
import { search, __resetAudit } from '@core/policy/audit';

const HERE = dirname(fileURLToPath(import.meta.url));

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };
const dana: Principal = { id: 'dana', domains: ['sales'], role: 'domain_admin' };
const sara: Principal = { id: 'sara', domains: ['sales'], role: 'admin' };
const fin: Principal = { id: 'fatima', domains: ['finance'], role: 'builder' };

let changes: ProjectChange[] = [];
let off: () => void = () => {};
beforeEach(() => {
  __resetStore();
  __resetAudit();
  changes = [];
  off = onProjectChange((c) => changes.push(c));
});
afterEach(() => off());

function documentedSilver(): string {
  const d = createDataset(amir, { name: 'Goods Receipts' });
  buildVersion(d.id, amir, 'bronze', { quality: 'passing', artifact: 'b' });
  buildVersion(d.id, amir, 'silver', { quality: 'passing', artifact: 's' });
  setDocs(d.id, amir, { description: 'Receipts.', columns: [{ name: 'receipt_id', description: 'Key.' }] });
  return d.id;
}

function promoted(): string {
  const id = documentedSilver();
  applyApprovedPromotion(requestPromotion(id, amir, { visibility: 'domain' }), dana);
  return id;
}

function audienceAudits(id: string) {
  return search({ action: 'audience.change' }).filter((e) => e.subject.startsWith(`dataset:${id} `));
}

function lastChange(id: string): ProjectChange {
  const mine = changes.filter((c) => c.datasetId === id);
  assert.ok(mine.length, 'no project-change event (no version commit) was emitted');
  return mine[mine.length - 1];
}

test('promotion (the incident shape: private → domain + a domain grant) is audited and versioned', () => {
  const id = documentedSilver();
  assert.equal(audienceAudits(id).length, 0, 'building and documenting change no audience');
  applyApprovedPromotion(requestPromotion(id, amir, { visibility: 'domain' }), dana);
  const [a] = audienceAudits(id);
  assert.ok(a, 'no governance audience.change audit event');
  assert.equal(a.actor, 'dana');
  assert.equal(a.domain, 'sales');
  assert.match(a.subject, new RegExp(`^dataset:${id} \\(Goods Receipts\\)$`), 'the audit target carries the dataset id (indexed)');
  assert.match(a.reason, /^promote: tier dataset → asset, visibility private → domain, grants \+domain:sales$/);
  const c = lastChange(id);
  assert.equal(c.actorId, 'dana');
  assert.equal(c.action, 'promote: tier dataset → asset, visibility private → domain, grants +domain:sales');
});

test('unshare (asset → private) is audited and versioned', () => {
  const id = promoted();
  transition(id, dana, 'unshare');
  const a = audienceAudits(id).find((e) => e.reason.startsWith('unshare:'));
  assert.ok(a, 'unshare left no audit event');
  assert.match(a.reason, /tier asset → dataset, visibility domain → private, grants -domain:sales/);
  assert.match(lastChange(id).action, /^unshare: tier asset → dataset/);
});

test('certify and decertify are audited and versioned', () => {
  const id = promoted();
  certify(id, sara, { level: 'gold', visibility: 'shared' });
  assert.ok(audienceAudits(id).some((e) => e.actor === 'sara' && /^certify: tier asset → product, visibility domain → shared/.test(e.reason)));
  assert.match(lastChange(id).action, /^certify: tier asset → product/);
  transition(id, sara, 'decertify');
  assert.ok(audienceAudits(id).some((e) => /^decertify: tier product → asset/.test(e.reason)));
  assert.match(lastChange(id).action, /^decertify: tier product → asset/);
});

test('an import (a grant-only change) is audited and versioned', () => {
  const id = promoted();
  certify(id, sara, {});
  importProduct(id, fin);
  const a = audienceAudits(id).find((e) => e.reason.startsWith('import product:'));
  assert.ok(a, 'import left no audit event');
  assert.equal(a.actor, 'fatima');
  assert.match(a.reason, /^import product: grants \+domain:finance$/);
  assert.equal(lastChange(id).action, 'import product: grants +domain:finance');
});

test('a write that does not change the audience is not an audience event', () => {
  const id = promoted();
  const before = audienceAudits(id).length;
  setDocs(id, dana, { description: 'Receipts, refreshed.' });
  assert.equal(audienceAudits(id).length, before);
  assert.equal(lastChange(id).action, 'edit docs');
});

test('dataset.yaml cannot change tier / visibility / grants (the ungated bypass is closed)', () => {
  const id = documentedSilver();
  const f = readFile(id, amir, 'dataset.yaml');
  const escalated = f.content.replace('tier: dataset', 'tier: asset').replace('visibility: private', 'visibility: domain');
  assert.notEqual(escalated, f.content, 'fixture: the yaml carries tier + visibility');
  assert.throws(
    () => writeFile(id, amir, { path: 'dataset.yaml', content: escalated, sha: f.sha }),
    (e: DatasetError) => e.status === 403 && /tier, visibility/.test(e.message),
  );
  assert.equal(getDataset(id, amir).tier, 'dataset', 'nothing was written');
  assert.equal(audienceAudits(id).length, 0);
  // A content edit through the same door still works.
  const edited = f.content.replace('description: Receipts.', 'description: Receipts (edited).');
  writeFile(id, amir, { path: 'dataset.yaml', content: edited, sha: f.sha });
  assert.equal(getDataset(id, amir).description, 'Receipts (edited).');
});

// ---------------------------------------------------------------------- ratchets --

/** Top-level function bodies of a source file, by name (brace-matched; good enough for our style). */
function functionBodies(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /^(?:export )?(?:async )?function (\w+)/gm;
  // The body opens on the first line that ends with `{` after a `)` (multi-line signatures carry
  // object types whose braces are not the body).
  const bodyOpen = /\)[^\n]*\{[ \t]*$/m;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const open = bodyOpen.exec(src.slice(m.index));
    if (!open) continue;
    let depth = 1;
    let i = m.index + open.index + open[0].length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
    }
    out.set(m[1], src.slice(m.index, i));
  }
  return out;
}

for (const [label, rel, varName, allowedYamlWriters] of [
  ['data', 'store.ts', 'd', ['persist', 'writeThrough', 'markDatasetsSourceRevoked', 'markDatasetsDrifted', 'reassignOwner']],
  ['files', '../../files/lib/store.ts', 'a', ['persist', 'writeThrough', 'reassignOwner', 'restoreFileVersion', 'recordIndexOutcome']],
] as const) {
  test(`RATCHET (${label}): every function that changes tier/visibility/grants writes through persist`, () => {
    const src = readFileSync(join(HERE, rel), 'utf8');
    const assigns = new RegExp(`\\b${varName}\\.(tier|visibility|grants)\\s*=[^=]`);
    const offenders: string[] = [];
    for (const [name, body] of functionBodies(src)) {
      if (name.startsWith('__') || name === 'persist') continue;
      if (!assigns.test(body)) continue;
      // Creators build a NEW record (nothing to compare); everything else must persist.
      if (/writeNewRecord\(|writeNew\(|\.store\.set\(/.test(body)) continue;
      if (!/\bpersist\(/.test(body)) offenders.push(name);
    }
    assert.deepEqual(offenders, [], `these change an audience without the audited persist: ${offenders.join(', ')}`);
  });

  test(`RATCHET (${label}): only the pinned functions write a record's yaml directly`, () => {
    const src = readFileSync(join(HERE, rel), 'utf8');
    const writers = [...functionBodies(src)].filter(([, body]) => /\brec\.yaml\s*=[^=]/.test(body)).map(([n]) => n).sort();
    assert.deepEqual(
      writers,
      [...allowedYamlWriters].sort(),
      'a new direct `rec.yaml =` write bypasses the audience choke point — route it through persist, or (if it provably cannot change tier/visibility/grants) pin it here',
    );
  });
}

test('RATCHET: the committed dbt definition carries visibility + grantees (an audience-only change is never an empty commit)', () => {
  const src = readFileSync(join(HERE, 'dbt', 'schema.ts'), 'utf8');
  assert.match(src, /os_visibility: d\.visibility/);
  assert.match(src, /os_grantees:/);
});
