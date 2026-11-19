/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * FEATURE:    The scanner's chart contract — RBAC, the flag, the image pin, the NetworkPolicy
 * USER STORY: As an operator I want the permissions the scanner needs to be exactly the ones it
 *             uses, visible in one file, and I want a future edit that widens them to fail a test
 *             rather than ship.
 * ARCHITECTURE:
 *   The adapter is useless without the Role that lets it create a Job and read a pod log, and a
 *   Role is YAML no unit test would otherwise see — the class of defect PR B3/B4 hit twice (a
 *   missing `batch/cronjobs` rule that 403'd silently, and a namespace-wide Secrets grant nobody
 *   had asked for). This reads the chart files directly, the way
 *   `core/ui/charts/vendor-licence.test.ts` reads the licence manifest, so it needs no `helm`
 *   binary; `helm lint` in the gates covers rendering. It also pins the two things that are easy
 *   to break by accident: the image is PINNED (never `:latest`), and nothing in the scanner's
 *   chart surface touches OS_OFFLINE_MOCK.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// os-ui/tabs/software/lib -> repo root
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');

const TEMPLATE = 'charts/sovereign-agentic-os/templates/base/os-ui/software-scanner.yaml';
const VALUES = 'charts/sovereign-agentic-os/values.yaml';
const ENV_TPL = 'charts/sovereign-agentic-os/templates/base/os-ui/_os-ui-env.tpl';
const EGRESS = 'charts/sovereign-agentic-os/templates/base/network/egress-policies.yaml';

test('the scanner Role grants jobs, pods/log and a WRITE-ONLY secret — nothing else', () => {
  const y = read(TEMPLATE);
  assert.ok(y.includes('kind: Role'), 'a namespaced Role, not a ClusterRole');
  assert.ok(!y.includes('ClusterRole'), 'the scanner must never need cluster-wide power');
  assert.ok(y.includes('name: os-ui-software-scanner'));

  // Exactly three rules, each with a named resource list.
  const groups = [...y.matchAll(/apiGroups: \[([^\]]*)\]/g)].map((m) => m[1]);
  assert.deepEqual(groups, ['"batch"', '""', '""'], 'batch/jobs, pods+log, secrets');

  const resources = [...y.matchAll(/resources: \[([^\]]*)\]/g)].map((m) => m[1]);
  assert.deepEqual(resources, ['"jobs"', '"pods", "pods/log"', '"secrets"']);

  const verbs = [...y.matchAll(/verbs: \[([^\]]*)\]/g)].map((m) => m[1]);
  assert.deepEqual(verbs, [
    // jobs: the lifecycle of one scan.
    '"create", "get", "list", "watch", "delete"',
    // pods/log: read-only — the result is the pod's stdout.
    '"get", "list", "watch"',
    // THE LINE THAT MATTERS: the app's source is WRITTEN to a Secret and deleted. No `get`, no
    // `list` — so this grant can never be used to read another secret in the namespace — and no
    // `patch`/`update`, because the Job-owner reference is set at creation.
    '"create", "delete"',
  ]);
  assert.ok(!y.includes('"configmaps"'), 'a ConfigMap is not audit-redacted; the payload is a Secret');
  assert.ok(!/pods\/exec/.test(y), 'no exec into a pod holding an app\'s source');

  // Bound to the os-ui ServiceAccount in the release namespace, and nothing else.
  assert.ok(y.includes('kind: RoleBinding'));
  assert.ok(y.includes('name: os-ui'));
});

test('M3: the scan namespace is an operator value, defaulting to the release namespace', () => {
  const y = read(TEMPLATE);
  assert.match(y, /\$scanNs\s*:=\s*\$sc\.namespace \| default \.Release\.Namespace/, 'one resolution, used everywhere');
  assert.ok(!/namespace: \{\{ \.Release\.Namespace \}\}\n\s+labels:[\s\S]*?name: os-ui-software-scanner/.test(y));
  // A dedicated namespace must not start life WIDE OPEN: it carries no inherited policy.
  assert.ok(y.includes('name: software-scanner-default-deny'), 'a dedicated namespace gets the baseline');
  assert.ok(y.includes('pod-security.kubernetes.io/enforce: restricted'));
  // And the accept for the default layout is written down where the grant is, not only in a doc.
  assert.match(y, /ACCEPTED, AND NOT IDEAL/, 'the pods/log breadth is acknowledged at the grant');
  const values = read(VALUES);
  assert.match(values, /^\s{6}namespace: ""$/m, 'default = the release namespace');
  assert.ok(values.includes('software-scans'), 'and the values comment names the better posture');
});

test('H3: the payload is a Secret volume, not an env var — and the plan says why', () => {
  const y = read(TEMPLATE);
  assert.match(y, /MAX_ARG_STRLEN/, 'the reason the env-var delivery was abandoned is recorded');
  const plan = read('docs/superpowers/plans/2026-11-19-software-scanner-trivy.md');
  assert.ok(plan.includes('MAX_ARG_STRLEN'), 'and in the plan, where a reviewer looks first');
});

test('the whole scanner surface is behind osUI.software.scanner.enabled', () => {
  const y = read(TEMPLATE);
  assert.match(y, /^\{\{-\s*\$sc\s*:=\s*\(\(\.Values\.osUI\.software/m, 'nil-safe under --reuse-values');
  assert.match(y, /\{\{-\s*if\s+\$sc\.enabled/, 'the file renders nothing when the flag is off');
  // The flag defaults ON: a cluster with no scanner cannot approve a deploy at all.
  const values = read(VALUES);
  const block = values.slice(values.indexOf('  software:\n'), values.indexOf('  image:\n', values.indexOf('  software:\n')));
  assert.ok(block.includes('scanner:'), 'the values key exists where the template expects it');
  assert.match(block, /enabled: true/, 'the scanner is on by default');
});

test('the scanner image is PINNED, from the Apache-2.0 upstream', () => {
  const values = read(VALUES);
  const i = values.indexOf('      image:\n        repository: aquasec/trivy');
  assert.ok(i > 0, 'the chart names aquasec/trivy explicitly');
  const block = values.slice(i, i + 400);
  assert.match(block, /tag: "\d+\.\d+\.\d+"/, 'a pinned version, never a floating tag');
  assert.ok(!/tag: "?latest/.test(block), ':latest is not a pin');
  assert.ok(block.includes('digest:'), 'and a place to pin the digest');
  // The licence manifest must know about it (CONTRIBUTING: a bundled component needs a row).
  assert.ok(read('licenses/components.tsv').includes('Trivy (aquasec/trivy)'));
  assert.ok(read('THIRD-PARTY-LICENSES.md').includes('Trivy'));
  assert.ok(read('NOTICE').includes('Trivy'));
});

test('H2: the DB-mirror rule is SCOPED to public address space, not "port 443 anywhere"', () => {
  const y = read(TEMPLATE);
  const egress = y.slice(y.indexOf('name: software-scanner-egress'));
  const rule = egress.slice(egress.indexOf('port: 8053'));
  // The defect this pins: a `ports:`-only rule with no `to:` grants 443 to EVERY destination —
  // the API server and every platform service included — which is wider than the egress-proxy
  // chokepoint it was supposed to be narrower than.
  assert.match(rule, /- to:\n\s+- ipBlock:/, 'the 443 rule must carry a `to:` block');
  assert.ok(rule.includes('cidr: 0.0.0.0/0'), 'public space...');
  for (const priv of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']) {
    assert.ok(rule.includes(priv), `...minus ${priv}, the same subtraction the egress proxy uses`);
  }
  const proxy = read(EGRESS);
  for (const priv of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']) {
    assert.ok(proxy.includes(priv), 'and that subtraction is still what the chokepoint does');
  }
});

test('the scan pods get DNS + the DB mirror, and are off the in-namespace plane', () => {
  const y = read(TEMPLATE);
  assert.ok(y.includes('kind: NetworkPolicy'));
  assert.ok(y.includes('name: software-scanner-egress'));
  assert.ok(y.includes('app.kubernetes.io/component: software-scanner'), 'the selector the Job labels match');
  assert.ok(y.includes('port: 53'), 'DNS always');
  assert.match(y, /\{\{-\s*if\s+ne\s+\(\$sc\.dbMode[^\n]*"offline"\s*\}\}/, 'and 443 only when a mirror is used');
  assert.ok(y.includes('name: software-scanner-no-ingress'), 'nothing may reach a scan pod');

  // The blanket namespace allows must EXCLUDE the scanner, or the dedicated policy means nothing
  // (NetworkPolicy is additive).
  const egress = read(EGRESS);
  const notIn = [...egress.matchAll(/operator: NotIn, values: \[([^\]]*)\]/g)].map((m) => m[1]);
  assert.equal(notIn.length, 2, 'the intra-namespace and API-server allows');
  for (const v of notIn) assert.ok(v.includes('software-scanner'), `scanner must be excluded: ${v}`);
});

test('the scanner env reaches BOTH os-ui and the worker, and weakens nothing', () => {
  const tpl = read(ENV_TPL);
  // Declared inside the RUN-path block, which is the only list the worker pod gets — so the UI
  // and the pod that executes agent runs can never disagree about whether a scanner exists.
  const run = tpl.slice(tpl.indexOf('define "soa.osUI.runEnv"'), tpl.indexOf('define "soa.osUI.adminEnv"'));
  for (const key of [
    'SOFTWARE_SCANNER_ENABLED',
    'SOFTWARE_SCANNER_IMAGE',
    'SOFTWARE_SCANNER_NAMESPACE',
    'SOFTWARE_SCANNER_DB_MODE',
    'SOFTWARE_SCANNER_DB_REPOSITORY',
    'SOFTWARE_SCANNER_TIMEOUT_MS',
  ]) {
    assert.ok(run.includes(key), `${key} must be in the RUN-path env`);
  }
  // THE LINE NOT TO CROSS: the scanner is what `offlineMock: refuse` asks an operator to wire,
  // and it must not quietly become a way to re-open fabrication.
  assert.match(tpl, /- name: OS_OFFLINE_MOCK\n\s+value: \{\{ \$u\.offlineMock \| default "refuse" \| quote \}\}/);
  const values = read(VALUES);
  assert.match(values, /^\s{2}offlineMock: refuse$/m, 'the default stays `refuse`');
  // The scanner template may MENTION the lever in prose (it should — it is the thing an
  // operator reads when `refuse` blocks a deploy), but it must never SET it.
  assert.ok(
    !/- name: OS_OFFLINE_MOCK|OS_OFFLINE_MOCK\s*[:=]/.test(read(TEMPLATE)),
    'the scanner template must not set OS_OFFLINE_MOCK',
  );
});

test('the approver UI and the kernel agree on the audited-reason floor', () => {
  // The floor lives in `@core/policy/approvals` (AUDITED_OVERRIDE_REASON_MIN) and is enforced
  // server-side. `ReviewCard.tsx` is a client component and cannot import a `server-only` module,
  // so the number is duplicated there — which is exactly the kind of duplicate that drifts. A test
  // may not IMPORT a .tsx, so this reads it as text, the way the vendor-licence test does.
  const kernel = read('os-ui/core/policy/approvals.ts');
  const m = kernel.match(/AUDITED_OVERRIDE_REASON_MIN = (\d+)/);
  assert.ok(m, 'the kernel must define the floor');
  const ui = read('os-ui/tabs/governance/ui/ReviewCard.tsx');
  const u = ui.match(/const NO_SCAN_REASON_MIN = (\d+)/);
  assert.ok(u, 'the card must state the floor it enforces in the browser');
  assert.equal(u[1], m[1], 'the card and the kernel must not drift apart');
  const review = read('os-ui/tabs/software/lib/review.ts');
  assert.ok(
    review.includes('NO_SCAN_REASON_MIN = AUDITED_OVERRIDE_REASON_MIN'),
    'and the enforcing tab must take the number from the kernel, not restate it',
  );
});
