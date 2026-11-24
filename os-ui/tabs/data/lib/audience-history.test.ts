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
  moveDatasetsDomain,
  type Principal,
} from '@tabs/data/lib/store';
import { DatasetError } from '@tabs/data/lib/dataset-schema';
import { onProjectChange, type ProjectChange } from '@tabs/data/lib/project-events';
import { search, __resetAudit } from '@core/policy/audit';
import { publishPersonalDataRule } from '@core/policy/personal-data-rule';

// This file tests certification for another concern; the personal-data rule (admin setting) has its
// own tests (tabs/data/lib/personal-data-gate.test.ts). Its default `block` would refuse these
// unclassified fixtures, so the rule is off here.
publishPersonalDataRule('off', true);

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
  certify(id, sara, { level: 'gold' });
  assert.ok(audienceAudits(id).some((e) => e.actor === 'sara' && /^certify: tier asset → product, visibility domain → public/.test(e.reason)));
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

test('a domain move is an audience change: audited with the acting admin, and the domain grant follows', () => {
  const id = promoted();
  const moved = moveDatasetsDomain({ id }, 'finance', 'sara');
  assert.deepEqual(moved, [id]);
  const d = getDataset(id, { id: 'sara', domains: ['finance'], role: 'admin' });
  assert.deepEqual(d.grants.map((g) => `${g.grantee.kind}:${g.grantee.id}`), ['domain:finance'], 'the old domain must not keep its read grant');
  const a = search({ action: 'audience.change' }).find((e) => e.subject.startsWith(`dataset:${id} `) && e.reason.startsWith('move domain:'));
  assert.ok(a, 'a domain move left no audience event');
  assert.equal(a.actor, 'sara');
  assert.equal(a.reason, 'move domain: domain sales → finance, grants +domain:finance -domain:sales');
  // The NEW domain's repo gets the change named; the old domain's repo gets a plain 'move domain'
  // (it only loses the dataset).
  const toNew = changes.find((c) => c.datasetId === id && c.domain === 'finance');
  assert.match(toNew?.action ?? '', /^move domain: domain sales → finance/);
});

test('dataset.yaml: absent vs empty governance values are not a change (imports: [] round-trips)', () => {
  const id = documentedSilver();
  const f = readFile(id, amir, 'dataset.yaml');
  assert.doesNotMatch(f.content, /^imports:/m, 'fixture: no imports key');
  const withEmpty = `${f.content.trimEnd()}\nimports: []\n`;
  writeFile(id, amir, { path: 'dataset.yaml', content: withEmpty, sha: f.sha });
  assert.equal(getDataset(id, amir).tier, 'dataset');
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

/**
 * The ratchet's pins, per store. Each entry is a function that is allowed to do the flagged thing
 * WITHOUT going through `persist`, and why. Adding a name here is a reviewed decision.
 *
 * LIMITS (also in ARCHITECTURE.md): a regex scan of `function` declarations in these two store
 * files. It does not see a write made from another module (only the store holds the Map and the
 * mirror, so another module cannot write a record without an exported store function), nor a write
 * hidden behind an aliased property name or a helper that mutates its argument. Top-level code
 * outside every function is scanned as a whole and must hold none of the patterns.
 */
const PINS: Record<string, { rel: string; audience: Record<string, string>; direct: Record<string, string> }> = {
  data: {
    rel: 'store.ts',
    // assigns tier/visibility/grants without persist
    audience: {},
    // writes the record's mirror / Map / yaml directly (writeThrough( | .store.set( | .yaml = | writeNew…)
    direct: {
      writeThrough: 'the merge-write itself',
      writeNewRecord: 'the first write of a NEW record',
      hydrate: 'loads records from the mirror (no change)',
      createDataset: 'a NEW private record — nothing to compare',
      adoptConnectedDataset: 'a NEW record born at domain tier; audited at its route',
      __seedDatasetForTest: 'test hook',
      markDatasetsSourceRevoked: 'flips connected.status / sync only',
      markDatasetsDrifted: 'flips connected.status only',
      reassignOwner: 'owner of a PRIVATE dataset only (tier dataset) — follow-up: audit it',
      archiveDataset: 'archived flag only',
      unarchiveDataset: 'archived flag only',
    },
  },
  files: {
    rel: '../../files/lib/store.ts',
    audience: {
      ensureSeeded: 'builds NEW seed records (the seed list is empty)',
      restoreFileVersion: 'pins the CURRENT audience onto the restored content (tested)',
    },
    direct: {
      writeThrough: 'the merge-write itself',
      hydrateFiles: 'loads records from the mirror (no change)',
      ensureSeeded: 'builds NEW seed records',
      createFile: 'a NEW private record — nothing to compare',
      __putRecordForTests: 'test hook',
      attachObject: 'object bytes only',
      reassignOwner: 'owner of a PRIVATE file only — follow-up: audit it',
      deleteFile: 'a delete',
      archiveFile: 'archived flag only',
      unarchiveFile: 'archived flag only',
      restoreFileVersion: 'content restore with the current audience pinned',
      recordIndexOutcome: 'index outcome only',
    },
  },
};

const AUDIENCE_ASSIGN = /\.(tier|visibility|grants)\s*=[^=]|\[['"`](tier|visibility|grants)['"`]\]\s*=[^=]/;
const DIRECT_WRITE = /\bwriteThrough\(|\.store\.set\(|\.yaml\s*=[^=]|\bwriteNew(Record)?\(|\bwriteMergedYaml\(/;

for (const [label, pin] of Object.entries(PINS)) {
  test(`RATCHET (${label}): any assignment to tier/visibility/grants goes through persist (or is pinned)`, () => {
    const src = readFileSync(join(HERE, pin.rel), 'utf8');
    const offenders: string[] = [];
    for (const [name, body] of functionBodies(src)) {
      if (name === 'persist' || !AUDIENCE_ASSIGN.test(body) || name in pin.audience) continue;
      if (!/\bpersist\(/.test(body)) offenders.push(name);
    }
    assert.deepEqual(offenders, [], `these change an audience without the audited persist: ${offenders.join(', ')}`);
  });

  test(`RATCHET (${label}): only the pinned functions write a record directly (writeThrough / store.set / yaml =)`, () => {
    const src = readFileSync(join(HERE, pin.rel), 'utf8');
    const writers = [...functionBodies(src)].filter(([n, body]) => n !== 'persist' && DIRECT_WRITE.test(body)).map(([n]) => n).sort();
    assert.deepEqual(
      writers,
      Object.keys(pin.direct).sort(),
      'a new direct write bypasses the audience choke point — route it through persist, or (if it provably cannot change who can see the record) pin it with a reason',
    );
  });

  test(`RATCHET (${label}): no top-level code outside a function assigns an audience or writes a record`, () => {
    let rest = readFileSync(join(HERE, pin.rel), 'utf8');
    for (const body of functionBodies(rest).values()) rest = rest.replace(body, '');
    // Pinned top-level writer: the mirror refresher's `put` loads the NEWEST mirrored copy into
    // the Map (a read of what another process wrote — it changes nothing). Exactly one is allowed.
    const refreshers = rest.match(/const refresher = mirrorRefresher[\s\S]*?\n\}\);/g) ?? [];
    assert.equal(refreshers.length, 1, 'expected exactly the one mirror refresher at top level');
    rest = rest.replace(refreshers[0], '');
    const code = rest.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, AUDIENCE_ASSIGN);
    assert.doesNotMatch(code, DIRECT_WRITE);
  });
}

test('RATCHET self-check: the scan catches a direct audience write that skips persist', () => {
  const bad = "export function sneaky(id: string): void {\n  const x = parse(get(id).yaml);\n  x['visibility'] = 'domain';\n  writeThrough(get(id));\n}\n";
  const [[name, body]] = [...functionBodies(bad)];
  assert.equal(name, 'sneaky');
  assert.match(body, AUDIENCE_ASSIGN);
  assert.match(body, DIRECT_WRITE);
  assert.doesNotMatch(body, /\bpersist\(/);
});

test('RATCHET: the committed dbt definition carries visibility + grantees (an audience-only change is never an empty commit)', () => {
  const src = readFileSync(join(HERE, 'dbt', 'schema.ts'), 'utf8');
  assert.match(src, /os_visibility: d\.visibility/);
  assert.match(src, /os_grantees:/);
});
