/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * FEATURE:    The audited no-scan approval hatch on `decideDeploy`
 * USER STORY: As an administrator I must be able to ship a deploy when no scanner can run — but
 *             only by saying so explicitly, in writing, on the record. As an auditor I must be
 *             able to find every such approval, who made it and why.
 * ARCHITECTURE:
 *   The hatch is a GOVERNANCE control, not an exemption: it never makes the OS claim a clean
 *   scan, and it is unreachable when a scan RAN and FAILED — a real finding still blocks, which
 *   is the line that keeps this from becoming "click here to skip security".
 *
 *   Four gates, each asserted below: the scan must be `unavailable` (not failed), the actor must
 *   be `admin` (NOT domain_admin, which is the rank that approves artefact promotions and would
 *   otherwise inherit this by accident), the acknowledgement must be explicit, and the reason
 *   must be substantive (>= 20 characters — long enough that "ok" cannot be the record).
 *   The decision writes three places: the review card, the Governance approval's effect, and a
 *   hash-chained `core/policy/audit.ts` row.
 */
import { test, before, after } from 'node:test';
import { mkdtempSync as __mkdtemp, rmSync as __rm } from 'node:fs';
import { tmpdir as __tmpdir } from 'node:os';
import { join as __join } from 'node:path';
import { config as __repoCfg } from '@core/kernel/config';

// WP-54 follow-up: a deploy request PINS a git commit before it is scanned, so these tests need a
// real repos directory (the same arrangement as review.test.ts).
let __reposDir = '';
let __priorRepos = '';
before(() => {
  __reposDir = __mkdtemp(__join(__tmpdir(), 'os-repos-t-'));
  __priorRepos = __repoCfg.reposDir;
  (__repoCfg as { reposDir: string }).reposDir = __reposDir;
});
after(() => {
  (__repoCfg as { reposDir: string }).reposDir = __priorRepos;
  __rm(__reposDir, { recursive: true, force: true });
});
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import { createApp, saveAppFile } from '@tabs/software/lib/apps';
import { requestDeploy, decideDeploy, scanGate, __resetReviewCards } from './review.ts';
import { __resetApprovals, listApprovals, AUDITED_OVERRIDE_REASON_MIN } from '@core/policy/approvals';
import { __resetAudit, search, verifyChain } from '@core/policy/audit';
import { VERSION_DELIM, REPORT_DELIM, type ScanK8s, type ScanK8sText } from './scan-trivy.ts';
import { useGreenGates } from '@core/testing/gates';
useGreenGates();

const creator: CurrentUser = { id: 'alice', name: 'Alice', domains: ['sales'], role: 'creator' };
const builder: CurrentUser = { id: 'bob', name: 'Bob', domains: ['sales'], role: 'builder' };
const domainAdmin: CurrentUser = { id: 'dana', name: 'Dana', domains: ['sales'], role: 'domain_admin' };
const admin: CurrentUser = { id: 'ada', name: 'Ada', domains: ['sales'], role: 'admin' };

const GOOD_REASON = 'Scanner Job cannot reach the Trivy DB mirror; reviewed the diff by hand with the security lead.';
const LEAKED = 'const key = "AKIAIOSFODNN7EXAMPLE";\n';

function reset(): void {
  __resetApprovals();
  __resetReviewCards();
  __resetAudit();
}

/** A pending review card whose scan produced NO verdict (the cluster-with-no-scanner case). */
async function cardWithNoVerdict(name: string): Promise<string> {
  const app = await createApp(creator, { name, template: 'nextjs-supabase' });
  const res = await requestDeploy(app.id, creator, { scanMode: 'unavailable' });
  assert.equal(res.kind, 'review');
  if (res.kind !== 'review') throw new Error('expected a review card');
  assert.equal(res.card.scan.unavailable, true);
  assert.equal(res.card.scan.passed, false);
  return res.card.id;
}

/**
 * A pending review card whose scan RAN and FAILED — the case the hatch must refuse. The file is
 * saved by the BUILDER because the code editor is Builder+ (`apps.ts` `ensureBuilder`); the
 * leaked key then reaches the scan through the app's durable file mirror, exactly as
 * `review-security.test.ts` pins.
 */
async function cardWithFailedScan(name: string): Promise<string> {
  const app = await createApp(builder, { name, template: 'nextjs-supabase' });
  await saveAppFile(app.id, builder, { path: 'lib/creds.ts', content: LEAKED, sha: '' });
  const res = await requestDeploy(app.id, builder, { scanMode: 'live' });
  assert.equal(res.kind, 'review');
  if (res.kind !== 'review') throw new Error('expected a review card');
  assert.equal(res.card.scan.passed, false);
  assert.notEqual(res.card.scan.unavailable, true, 'this scan RAN; it just failed');
  return res.card.id;
}

// ------------------------------------------------------- a REAL live scan, mocked --

const SCAN_NS = 'agentic-os';
const SCAN_UID = 'job-uid-hatch';

/** A cluster whose scan Job succeeds and whose pod prints the given Trivy report. */
function liveScan(report: string): { scannerEnabled: true; trivy: { k8s: ScanK8s; k8sText: ScanK8sText } & Record<string, unknown> } {
  const k8s: ScanK8s = async (method, path) => {
    if (method === 'POST') return { status: 201, body: { metadata: { uid: SCAN_UID } } };
    if (method === 'DELETE') return { status: 200, body: {} };
    if (path.includes('/pods?')) {
      return {
        status: 200,
        body: { items: [{ metadata: { name: 'scan-pod', ownerReferences: [{ uid: SCAN_UID }] } }] },
      };
    }
    if (path.includes('/jobs/')) {
      return { status: 200, body: { metadata: { uid: SCAN_UID }, status: { succeeded: 1 } } };
    }
    return { status: 404, body: {} };
  };
  const k8sText: ScanK8sText = async () => ({
    status: 200,
    text: `${VERSION_DELIM}\n{}\n${REPORT_DELIM}\n${report}\n`,
  });
  return {
    scannerEnabled: true,
    trivy: {
      k8s,
      k8sText,
      namespace: SCAN_NS,
      image: 'aquasec/trivy:0.58.2',
      dbMode: 'mirror',
      dbRepository: 'ghcr.io/aquasecurity/trivy-db',
      timeoutMs: 5_000,
      runId: 'hatch001',
      sleep: async () => {},
    },
  };
}

/** What Trivy returns for the tree our scaffolds actually produce: nothing resolved. */
const RESOLVED_NOTHING = JSON.stringify({ SchemaVersion: 2, ArtifactName: '/work', Results: [] });

/**
 * A pending card from a REAL live scan over a GENERATED app: the engine ran, found nothing, and
 * could not resolve the dependencies because no lockfile is committed. This is the state that was
 * a dead end before the re-review: `mode: 'live'`, `passed: false`, `unavailable` UNSET.
 */
async function cardWithUncoveredDeps(name: string): Promise<{ cardId: string; appId: string }> {
  const app = await createApp(builder, { name, template: 'nextjs-supabase' });
  // A manifest with nothing on the known-bad list, and no lockfile — exactly what the scaffolds
  // emit, so the baseline layer adds no finding and the card really does carry zero.
  await saveAppFile(app.id, builder, {
    path: 'package.json',
    content: JSON.stringify({ name: 'generated', dependencies: { next: '^15.0.0' } }),
    sha: '',
  });
  const res = await requestDeploy(app.id, builder, { scan: liveScan(RESOLVED_NOTHING) });
  assert.equal(res.kind, 'review', 'an incomplete scan must open a review card, not auto-deploy');
  if (res.kind !== 'review') throw new Error('expected a review card');
  assert.equal(res.card.scan.mode, 'live', 'the engine DID run');
  assert.equal(res.card.scan.unavailable, undefined, 'and it is NOT the no-verdict state');
  assert.equal(res.card.scan.passed, false);
  assert.ok(res.card.scan.notRun?.includes('deps'), 'deps is declared uncovered');
  assert.ok(
    !res.card.scan.findings.some((f) => f.severity === 'high' || f.severity === 'critical'),
    'and nothing blocking was found',
  );
  return { cardId: res.card.id, appId: app.id };
}

async function refusal(fn: () => Promise<unknown>): Promise<{ message: string; status: number }> {
  try {
    await fn();
  } catch (e) {
    return { message: (e as Error).message, status: (e as { status?: number }).status ?? 0 };
  }
  throw new Error('expected a refusal, got none');
}

// ------------------------------------------------------------- without the hatch --

test('WITHOUT the acknowledgement an absent verdict still blocks, for an admin too', async () => {
  reset();
  try {
    const id = await cardWithNoVerdict('No Hatch');
    const r = await refusal(() => decideDeploy(id, admin, 'approve'));
    assert.equal(r.status, 409);
    assert.match(r.message, /no security verdict to approve/i);
  } finally {
    reset();
  }
});

// ----------------------------------------------------------------- the role gate --

test('a DOMAIN_ADMIN cannot use the hatch — it is admin-only, and the refusal says so', async () => {
  reset();
  try {
    const id = await cardWithNoVerdict('Domain Admin Hatch');
    const r = await refusal(() =>
      decideDeploy(id, domainAdmin, 'approve', undefined, { acknowledgeNoScan: true, reason: GOOD_REASON }),
    );
    assert.equal(r.status, 403);
    assert.match(r.message, /administrator/i);
    assert.ok(/domain_admin|domain admin/i.test(r.message), 'the refusal must name the caller\'s rank');
    // And nothing was written anywhere.
    assert.deepEqual(search({ action: 'deploy' }), []);
  } finally {
    reset();
  }
});

test('a BUILDER cannot use the hatch either', async () => {
  reset();
  try {
    const id = await cardWithNoVerdict('Builder Hatch');
    const r = await refusal(() =>
      decideDeploy(id, builder, 'approve', undefined, { acknowledgeNoScan: true, reason: GOOD_REASON }),
    );
    assert.equal(r.status, 403);
  } finally {
    reset();
  }
});

// --------------------------------------------------------------- the reason gate --

test('a MISSING or SHORT reason is refused — the reason IS the record', async () => {
  reset();
  try {
    for (const bad of [undefined, '', '   ', 'ok', 'scanner broken', '   too short   ']) {
      const id = await cardWithNoVerdict(`Reason ${String(bad)}`);
      const r = await refusal(() =>
        decideDeploy(id, admin, 'approve', undefined, { acknowledgeNoScan: true, reason: bad }),
      );
      assert.equal(r.status, 400, `reason ${JSON.stringify(bad)} must be refused`);
      assert.match(r.message, /reason/i);
      assert.match(r.message, /20/, 'the refusal must state the floor it enforces');
    }
    assert.deepEqual(search({ action: 'deploy' }), [], 'a refused acknowledgement writes no audit row');
  } finally {
    reset();
  }
});

// -------------------------------------------------- a REAL failure is not a hatch --

test('a scan that RAN and FAILED can NEVER be acknowledged', async () => {
  reset();
  try {
    const id = await cardWithFailedScan('Real Failure');
    const r = await refusal(() =>
      decideDeploy(id, admin, 'approve', undefined, { acknowledgeNoScan: true, reason: GOOD_REASON }),
    );
    assert.equal(r.status, 409);
    assert.match(r.message, /did not pass/i);
    assert.ok(
      /cannot be acknowledged|only.*unavailable|no verdict/i.test(r.message),
      `the refusal must explain that the hatch does not apply: ${r.message}`,
    );
    assert.deepEqual(search({ action: 'deploy' }), []);
  } finally {
    reset();
  }
});

// -------------------------------------------------------------- the happy path ----

test('an ADMIN with an explicit acknowledgement and a real reason ships it, on the record', async () => {
  reset();
  try {
    const id = await cardWithNoVerdict('Acknowledged');
    const { app, card } = await decideDeploy(id, admin, 'approve', 'going ahead', {
      acknowledgeNoScan: true,
      reason: GOOD_REASON,
    });

    // 1. The app went live and the card records WHAT KIND of approval this was.
    assert.equal(app.deploy.state, 'live');
    assert.equal(card.decision, 'approved');
    assert.equal(card.decidedBy, 'ada');
    assert.equal(card.approvedWithoutScan, true);
    assert.equal(card.noScanReason, GOOD_REASON);

    // 2. The Governance approval carries the same fact through the recordEffect seam, so the
    //    inbox shows it without the Software tab retelling the story.
    const governed = listApprovals({}).filter((a) => a.kind === 'app_deploy');
    assert.equal(governed.length, 1);
    assert.equal(governed[0].status, 'approved');
    const effect = governed[0].effect?.approvedWithoutScan;
    assert.ok(effect, 'the approval effect must carry the acknowledgement');
    assert.equal(effect.by, 'ada');
    assert.equal(effect.reason, GOOD_REASON);
    assert.equal(effect.scanMode, 'unavailable');

    // 3. The audit log: one hash-chained `deploy` row naming the admin, the reason and the flag.
    const rows = search({ action: 'deploy' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor, 'ada');
    assert.equal(rows[0].domain, 'sales');
    assert.equal(rows[0].reason, GOOD_REASON);
    assert.equal(rows[0].detail.approvedWithoutScan, true);
    assert.equal(rows[0].detail.cardId, id);
    assert.equal(rows[0].detail.appId, app.id);
    assert.equal(rows[0].detail.scanMode, 'unavailable');
    assert.ok(String(rows[0].detail.scanReason ?? '').length > 0, 'and WHY there was no verdict');
    assert.equal(verifyChain(), null, 'the acknowledgement cannot be removed without breaking the chain');
  } finally {
    reset();
  }
});

test('the acknowledgement is IGNORED when the scan passed — a normal approval stays normal', async () => {
  reset();
  try {
    const app = await createApp(creator, { name: 'Clean Scan', template: 'nextjs-supabase' });
    const res = await requestDeploy(app.id, creator, { scanMode: 'offline-mock' });
    assert.equal(res.kind, 'review');
    if (res.kind !== 'review') return;
    assert.equal(res.card.scan.passed, true);
    const { card } = await decideDeploy(res.card.id, admin, 'approve', undefined, {
      acknowledgeNoScan: true,
      reason: GOOD_REASON,
    });
    assert.equal(card.decision, 'approved');
    assert.equal(card.approvedWithoutScan, undefined, 'there was a verdict; nothing was waived');
    assert.deepEqual(search({ action: 'deploy' }), [], 'and nothing to audit as a waiver');
  } finally {
    reset();
  }
});

test('DENY needs no scanner and no acknowledgement, whatever the scan says', async () => {
  reset();
  try {
    const id = await cardWithNoVerdict('Denied');
    const { app, card } = await decideDeploy(id, builder, 'deny', 'not now');
    assert.equal(card.decision, 'denied');
    assert.equal(app.deploy.state, 'preview');
    assert.equal(card.approvedWithoutScan, undefined);
  } finally {
    reset();
  }
});

// ============================ re-review H-1: the dead end ============================
// A live scan over a GENERATED app (no lockfile) returns `passed: false` with `unavailable`
// unset and ZERO findings. Before this round that combination hit the "fix the findings and
// re-request" branch — naming no action, for a card with nothing to fix — and the hatch was
// refused, so EVERY generated app was undeployable on a scanner-enabled cluster.

test('H-1: a BUILDER is refused with text that names the real action, not "fix the findings"', async () => {
  reset();
  try {
    const { cardId } = await cardWithUncoveredDeps('Uncovered Builder');
    const r = await refusal(() => decideDeploy(cardId, builder, 'approve'));
    assert.equal(r.status, 409);
    // The wording is the finding: a Builder reading a card with zero findings must be told what
    // to DO about it.
    assert.ok(!/fix the findings/i.test(r.message), `must not say "fix the findings": ${r.message}`);
    assert.match(r.message, /could not cover/i);
    assert.match(r.message, /lockfile/i);
    assert.match(r.message, /Administrator may acknowledge/i, 'and that there IS a way through');
  } finally {
    reset();
  }
});

test('H-1: an ADMIN without the acknowledgement is still refused', async () => {
  reset();
  try {
    const { cardId } = await cardWithUncoveredDeps('Uncovered No Ack');
    const r = await refusal(() => decideDeploy(cardId, admin, 'approve'));
    assert.equal(r.status, 409);
    assert.match(r.message, /lockfile/i);
    assert.deepEqual(search({ action: 'deploy' }), []);
  } finally {
    reset();
  }
});

test('H-1: a DOMAIN_ADMIN cannot acknowledge an uncovered category either', async () => {
  reset();
  try {
    const { cardId } = await cardWithUncoveredDeps('Uncovered Domain Admin');
    const r = await refusal(() =>
      decideDeploy(cardId, domainAdmin, 'approve', undefined, { acknowledgeNoScan: true, reason: GOOD_REASON }),
    );
    assert.equal(r.status, 403);
    assert.match(r.message, /Administrator/i);
    assert.match(r.message, /lockfile/i, 'the refusal names the cheaper fix first');
  } finally {
    reset();
  }
});

test('H-1: a short reason is refused, and the refusal names what is being waived', async () => {
  reset();
  try {
    const { cardId } = await cardWithUncoveredDeps('Uncovered Short Reason');
    const r = await refusal(() =>
      decideDeploy(cardId, admin, 'approve', undefined, { acknowledgeNoScan: true, reason: 'ok' }),
    );
    assert.equal(r.status, 400);
    assert.match(r.message, new RegExp(String(AUDITED_OVERRIDE_REASON_MIN)));
    assert.match(r.message, /deps verdict/, 'not "without a scan" — a scan DID run');
  } finally {
    reset();
  }
});

test('H-1: an ADMIN with an acknowledgement ships it, audited as an UNCOVERED CATEGORY', async () => {
  reset();
  try {
    const { cardId, appId } = await cardWithUncoveredDeps('Uncovered Acknowledged');
    const { app, card } = await decideDeploy(cardId, admin, 'approve', undefined, {
      acknowledgeNoScan: true,
      reason: GOOD_REASON,
    });

    assert.equal(app.deploy.state, 'live', 'the dead end is gone: the app can ship');
    assert.equal(card.decision, 'approved');
    // The TWO facts stay apart: a scan ran here, so this is NOT "approved without a scan".
    assert.deepEqual(card.approvedWithUncoveredCategories, ['deps']);
    assert.equal(card.approvedWithoutScan, undefined, 'an engine ran; do not overstate the gap');
    assert.equal(card.noScanReason, GOOD_REASON);

    const governed = listApprovals({}).filter((a) => a.kind === 'app_deploy');
    assert.equal(governed.length, 1);
    const effect = governed[0].effect?.approvedWithoutScan;
    assert.ok(effect);
    assert.deepEqual(effect.uncoveredCategories, ['deps']);
    assert.equal(effect.scanMode, 'live', 'the record says the engine ran');
    assert.match(governed[0].effect?.applied ?? '', /INCOMPLETE/);

    const rows = search({ action: 'deploy' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor, 'ada');
    assert.equal(rows[0].reason, GOOD_REASON);
    // The key the reviewer asked for, and NOT the no-verdict one.
    assert.deepEqual(rows[0].detail.approvedWithUncoveredCategories, ['deps']);
    assert.equal(rows[0].detail.approvedWithoutScan, undefined);
    assert.equal(rows[0].detail.appId, appId);
    assert.equal(rows[0].detail.scanMode, 'live');
    assert.ok(String(rows[0].detail.scanEngine ?? '').includes('trivy'), 'and which engine said so');
    assert.ok(String(rows[0].detail.scanReason ?? '').includes('lockfile'));
    assert.equal(verifyChain(), null);
  } finally {
    reset();
  }
});

test('H-1: a HIGH finding ALONGSIDE an uncovered category is NOT acknowledgeable', async () => {
  reset();
  try {
    // The line that keeps this from becoming "click here to skip security": the engine found
    // something real, so no amount of acknowledgement gets past it — even though `deps` is also
    // uncovered and the card therefore looks like the approvable case.
    const app = await createApp(builder, { name: 'Uncovered And Blocking', template: 'nextjs-supabase' });
    await saveAppFile(app.id, builder, {
      path: 'package.json',
      content: JSON.stringify({ dependencies: { next: '^15.0.0' } }),
      sha: '',
    });
    const withHigh = JSON.stringify({
      SchemaVersion: 2,
      Results: [
        {
          Target: 'src/app.ts',
          Class: 'secret',
          Secrets: [{ RuleID: 'aws-access-key-id', Title: 'AWS Access Key ID', StartLine: 2 }],
        },
      ],
    });
    const res = await requestDeploy(app.id, builder, { scan: liveScan(withHigh) });
    assert.equal(res.kind, 'review');
    if (res.kind !== 'review') return;
    assert.ok(res.card.scan.notRun?.includes('deps'), 'deps is uncovered on this card too');
    assert.ok(res.card.scan.findings.some((f) => f.severity === 'critical'), 'and a secret was FOUND');

    const r = await refusal(() =>
      decideDeploy(res.card.id, admin, 'approve', undefined, { acknowledgeNoScan: true, reason: GOOD_REASON }),
    );
    assert.equal(r.status, 409);
    assert.match(r.message, /did not pass/i);
    assert.match(r.message, /FOUND something cannot be acknowledged/i);
    assert.deepEqual(search({ action: 'deploy' }), [], 'and nothing is recorded as waived');
  } finally {
    reset();
  }
});

test('H-1: a live scan that COVERED everything and found nothing just passes', async () => {
  reset();
  try {
    const app = await createApp(builder, { name: 'Resolved Clean', template: 'nextjs-supabase' });
    await saveAppFile(app.id, builder, { path: 'package.json', content: '{"dependencies":{}}', sha: '' });
    await saveAppFile(app.id, builder, { path: 'package-lock.json', content: '{"lockfileVersion":3,"packages":{"":{"dependencies":{}}}}', sha: '' });
    const resolved = JSON.stringify({
      SchemaVersion: 2,
      Results: [{ Target: 'package-lock.json', Class: 'lang-pkgs', Type: 'npm', Vulnerabilities: [] }],
    });
    const res = await requestDeploy(app.id, builder, { scan: liveScan(resolved) });
    // A Builder's own Personal app with a PASSING scan self-serves — which is the proof that the
    // scan really did pass, with no acknowledgement anywhere.
    assert.equal(res.kind, 'auto-deployed');
    assert.deepEqual(search({ action: 'deploy' }), []);
  } finally {
    reset();
  }
});

// ======================= re-review L-B: the cap must not open the hatch =======================

test('L-B: a card whose BLOCKING findings sat past the cap classifies as blocking, not uncovered', () => {
  // The hole: `scanGate` read `scan.findings`, which is CAPPED, while `passed` counts every
  // finding. A scan with (say) 210 criticals shows 200 of them — but if the shown slice had
  // happened to carry none, the gate would have said "nothing blocking found", fallen through to
  // `uncovered`, and made a scan with 210 real findings ACKNOWLEDGEABLE by an admin.
  const base = {
    mode: 'live' as const,
    passed: false,
    scannedAt: '2026-11-19T00:00:00Z',
    summary: { sast: 0, deps: 210, secrets: 0 },
    notRun: ['sast', 'deps'] as ('sast' | 'deps' | 'secrets')[],
    reason: 'dependencies not resolvable (no lockfile)',
  };

  // (a) The pathological card: the SHOWN findings are all low, the blocking ones are hidden.
  const hidden = scanGate({
    ...base,
    findings: [{ category: 'deps', severity: 'low', title: 'a low one', detail: '' }],
    truncated: true,
    blockingBeyondCap: true,
  });
  assert.equal(hidden.kind, 'blocking', 'a real finding is NEVER acknowledgeable, shown or not');

  // (b) The same card without the flag is the genuinely acknowledgeable state.
  const uncovered = scanGate({
    ...base,
    findings: [{ category: 'deps', severity: 'low', title: 'a low one', detail: '' }],
    truncated: true,
  });
  assert.equal(uncovered.kind, 'uncovered');

  // (c) And a card serialised before the flag existed still behaves off its visible findings.
  const legacy = scanGate({
    ...base,
    findings: [{ category: 'secrets', severity: 'critical', title: 'a key', detail: '' }],
  });
  assert.equal(legacy.kind, 'blocking');
});

test('L-B: an admin cannot acknowledge a card whose blocking findings are past the cap', async () => {
  reset();
  try {
    const app = await createApp(builder, { name: 'Hidden Blocking', template: 'nextjs-supabase' });
    await saveAppFile(app.id, builder, {
      path: 'package.json',
      content: JSON.stringify({ dependencies: { next: '^15.0.0' } }),
      sha: '',
    });
    // 210 criticals: more than the card can list, so some are genuinely hidden.
    const many = Array.from({ length: 210 }, (_, i) => ({
      VulnerabilityID: `CVE-x-${i}`,
      PkgName: `p${i}`,
      InstalledVersion: '1',
      Severity: 'CRITICAL',
    }));
    const res = await requestDeploy(app.id, builder, {
      scan: liveScan(
        JSON.stringify({
          SchemaVersion: 2,
          Results: [{ Target: 'package-lock.json', Class: 'lang-pkgs', Vulnerabilities: many }],
        }),
      ),
    });
    assert.equal(res.kind, 'review');
    if (res.kind !== 'review') return;
    assert.equal(res.card.scan.truncated, true);
    assert.equal(res.card.scan.blockingBeyondCap, true);

    const r = await refusal(() =>
      decideDeploy(res.card.id, admin, 'approve', undefined, { acknowledgeNoScan: true, reason: GOOD_REASON }),
    );
    assert.equal(r.status, 409);
    assert.match(r.message, /FOUND something cannot be acknowledged/i);
    assert.deepEqual(search({ action: 'deploy' }), []);
  } finally {
    reset();
  }
});

test('L-A: the uncovered refusal says "nothing BLOCKING", because low findings may be listed', async () => {
  reset();
  try {
    const { cardId } = await cardWithUncoveredDeps('Wording');
    const r = await refusal(() => decideDeploy(cardId, builder, 'approve'));
    // "found nothing" overstated it: a medium or low finding can sit on the card right above the
    // message, and a reviewer reading "found nothing" would rightly distrust the whole card.
    assert.ok(!/found nothing,/.test(r.message), `must not claim nothing was found: ${r.message}`);
    assert.match(r.message, /found nothing blocking/);
  } finally {
    reset();
  }
});
