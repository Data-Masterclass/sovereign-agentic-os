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
const PUBLIC_EGRESS = 'charts/sovereign-agentic-os/templates/base/network/_public-egress.tpl';

/** The Role object only (the admission policy below it has its own apiGroups/resources lists). */
const roleOf = (y: string) => y.slice(y.indexOf('kind: Role\n'), y.indexOf('kind: RoleBinding'));

test('the scanner Role grants jobs, pods/log and a WRITE-ONLY secret — nothing else', () => {
  const full = read(TEMPLATE);
  const y = roleOf(full);
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

  // Bound to the os-ui ServiceAccount in the release namespace (and the worker), nothing else.
  assert.ok(full.includes('kind: RoleBinding'));
  assert.ok(full.includes('name: os-ui'));
});

test('the scan runs in its OWN namespace: <release>-scans by default, the release namespace refused', () => {
  const y = read(TEMPLATE);
  const env = read(ENV_TPL);
  // ONE resolution (a named template), used by the chart objects AND the os-ui/worker env.
  assert.match(y, /\$scanNs\s*:=\s*include "soa\.scanner\.namespace" \./, 'the objects use the shared resolution');
  assert.match(env, /SOFTWARE_SCANNER_NAMESPACE\n\s+value: \{\{ include "soa\.scanner\.namespace" \. \| quote \}\}/, 'and so does the env');
  const helper = env.slice(env.indexOf('define "soa.scanner.namespace"'));
  assert.match(helper, /default \(printf "%s-scans" \.Release\.Namespace\)/, 'empty = <release>-scans');
  assert.match(helper, /if eq \$ns \.Release\.Namespace[\s\S]*?fail/, 'the release namespace fails the render');
  // No grant is ever rendered into the release namespace any more.
  assert.ok(!/\$scanNs\s*:=[^\n]*\.Release\.Namespace/.test(y), 'no fallback to the release namespace');
  assert.ok(!/ACCEPTED, AND NOT IDEAL/.test(y), 'the accepted pods/log breadth in the platform namespace is gone');
  // The namespace starts at default deny and Pod Security restricted.
  assert.ok(y.includes('name: software-scanner-default-deny'));
  assert.ok(y.includes('pod-security.kubernetes.io/enforce: restricted'));
  assert.ok(!/networkPolicies\.defaultDeny/.test(y.replace(/\{\{-?\s*\/\*[\s\S]*?\*\/\s*-?\}\}/g, '')), 'the deny is unconditional here');
  const values = read(VALUES);
  assert.match(values, /^\s{6}namespace: ""$/m, 'default = <release>-scans');
  assert.match(values, /^\s{6}createNamespace: true$/m, 'the chart creates it unless an operator does');
  assert.match(values, /^\s{6}createOsUiRoles: true$/m, 'and os-ui\'s Role in it, unless an operator does');
});

test('the operator switches mirror softwareRunner.environments (dev: namespace + Role are operator-owned)', () => {
  const y = read(TEMPLATE);
  assert.match(y, /if ne \(\$sc\.createNamespace \| toString\) "false"[\s\S]*?kind: Namespace/);
  assert.match(y, /if ne \(\$sc\.createOsUiRoles \| toString\) "false"[\s\S]*?kind: Role\n/);
  const dev = read('values.dev.yaml');
  const block = dev.slice(dev.indexOf('    scanner:\n'));
  assert.match(block, /createNamespace: false/);
  assert.match(block, /createOsUiRoles: false/);
});

test('the admission policy admits only the scanner\'s exact Job shape', () => {
  const y = read(TEMPLATE);
  const vap = y.slice(y.indexOf('kind: ValidatingAdmissionPolicy\n'), y.indexOf('kind: ValidatingAdmissionPolicyBinding'));
  assert.ok(vap.length > 0, 'a ValidatingAdmissionPolicy');
  assert.match(vap, /failurePolicy: Fail/);
  assert.match(vap, /kubernetes\.io\/metadata\.name: \{\{ \$scanNs \| quote \}\}/, 'scoped to the scanner namespace');
  assert.ok(!vap.includes('matchConditions'), 'it binds EVERY request there, not just os-ui');
  for (const r of ['"pods"', '"secrets"', '"jobs"']) assert.ok(vap.includes(r), `matches ${r}`);
  // Each fence the owner asked for, as an expression.
  assert.match(vap, /c\.image == %s\)" \(\$image \| toJson\)/, 'the pinned image, exactly');
  assert.match(vap, /v\.secret\.secretName == variables\.jobName/, 'only its own payload Secret');
  assert.match(vap, /has\(v\.emptyDir\) \|\|/, 'otherwise emptyDirs only (no projected token, hostPath, configMap, PVC)');
  assert.match(vap, /envFrom\.orValue\(\[\]\)\) == 0 && c\.\?env\.orValue\(\[\]\)\.all\(e, !has\(e\.valueFrom\)\)/, 'no envFrom / valueFrom');
  assert.match(vap, /automountServiceAccountToken\.orValue\(true\) == false/, 'no ServiceAccount token');
  assert.match(vap, /hostNetwork/);
  assert.match(vap, /runAsNonRoot/);
  assert.match(vap, /'ALL' in c\.\?securityContext\.\?capabilities\.\?drop/);
  assert.match(vap, /readOnlyRootFilesystem/);
  assert.match(vap, /'cpu' in c\.resources\.limits && 'memory' in c\.resources\.limits/, 'limits set');
  assert.match(vap, /object\.\?type\.orValue\('Opaque'\) == 'Opaque'/, 'Secrets: Opaque payloads only');
  const binding = y.slice(y.indexOf('kind: ValidatingAdmissionPolicyBinding'));
  assert.match(binding, /validationActions: \["Deny"\]/, 'Deny, not Warn');
  // The image the policy pins is the one the env hands os-ui, and it carries a digest.
  const env = read(ENV_TPL);
  assert.match(env, /SOFTWARE_SCANNER_IMAGE\n\s+value: \{\{ include "soa\.scanner\.image" \. \| quote \}\}/);
  assert.match(env.slice(env.indexOf('define "soa.scanner.image"')), /if not \$i\.digest[\s\S]*?fail/, 'no digest, no render');
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
  assert.match(block, /digest: "sha256:[0-9a-f]{64}"/, 'and pinned by digest (the admission policy admits nothing else)');
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
  // the API server and every platform service included.
  assert.match(rule, /- to:\n\s+- ipBlock:/, 'the 443 rule must carry a `to:` block');
  assert.ok(rule.includes('cidr: 0.0.0.0/0'), 'public space...');
  // ...minus the SHARED non-public list, the one the egress proxy uses too (review of #407: RFC1918 alone left
  // the SKE pod/Service range 100.64.0.0/10 and the API server endpoint in 240.0.0.0/4 reachable).
  assert.match(rule, /except:\n\s+\{\{- include "soa\.network\.nonPublicCidrs" \. \| nindent 14 \}\}/);
  const helper = read(PUBLIC_EGRESS);
  for (const c of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16', '240.0.0.0/4']) {
    assert.ok(helper.includes(`"${c}"`), `the helper leaves out ${c}`);
  }
  assert.match(helper, /\$api\.cidrs[\s\S]*\$api\.extraCidrs/, 'and the configured API server addresses');
  assert.ok(read(EGRESS).includes('include "soa.network.nonPublicCidrs"'), 'the egress proxy uses the same list');
});

test('the scan pods get DNS + the DB mirror, and are off the in-namespace plane', () => {
  const y = read(TEMPLATE);
  assert.ok(y.includes('kind: NetworkPolicy'));
  assert.ok(y.includes('name: software-scanner-egress'));
  assert.ok(y.includes('app.kubernetes.io/component: software-scanner'), 'the selector the Job labels match');
  assert.ok(y.includes('port: 53'), 'DNS always');
  assert.match(y, /\{\{-\s*if\s+ne\s+\(\$sc\.dbMode[^\n]*"offline"\s*\}\}/, 'and 443 only when a mirror is used');
  // Nothing may reach a scan pod: the namespace's default deny covers ingress for every pod.
  const deny = y.slice(y.indexOf('name: software-scanner-default-deny'), y.indexOf('name: software-scanner-egress'));
  assert.match(deny, /podSelector: \{\}\n\s+policyTypes:\n\s+- Ingress\n\s+- Egress/);

  // The release namespace's blanket allows still EXCLUDE the scanner component, so a scan pod could
  // not borrow them even if someone created one there (NetworkPolicy is additive).
  const egress = read(EGRESS);
  // Component-keyed exclusions only: the API-server allow also excludes the model gateway by NAME while
  // it is behind the egress proxy (its own policy is templates/base/litellm/egress-policy.yaml).
  const notIn = [...egress.matchAll(/key: app\.kubernetes\.io\/component, operator: NotIn, values: \[([^\]]*)\]/g)].map((m) => m[1]);
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
