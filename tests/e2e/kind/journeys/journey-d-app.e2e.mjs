/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       acceptance harness (tests/e2e/kind)
 * FEATURE:    AT-d journey-d-app.e2e — app with a vulnerable lockfile → Trivy blocks → fix →
 *             approval by a builder → deploy → a viewer logs in and calls a granted agent
 * USER STORY: As the owner I want proof that Trivy (not the OS) decides whether an app may ship,
 *             that a second person approves it, that what runs is the digest that was scanned,
 *             that the app is fenced off from Trino and OpenSearch, and that a viewer's agent call
 *             through the app is traced as the viewer.
 * ARCHITECTURE:
 *   - Authoritative: 09 §5 AT-d; MASTER-PLAN Part 2 §C row AT-d; 10 F14; 11 A26–A28 (WP-54).
 *   - Records: scan Job log (Trivy's own output), commit_checks (OS row, paired with the Trivy log),
 *     OPA decision log, Kubernetes Deployment + pod imageID, Trivy Operator VulnerabilityReport,
 *     Keycloak login, Langfuse observations, Calico-enforced NetworkPolicy probe.
 */
import { journey, check } from '../lib/journey.mjs';
import { PRINCIPALS, DOMAIN, waitFor, isoNow } from '../lib/common.mjs';
import { callTool } from '../lib/os-driver.mjs';
import * as stub from '../lib/records/stub.mjs';
import * as opa from '../lib/records/opa.mjs';
import * as pg from '../lib/records/postgres.mjs';
import * as langfuse from '../lib/records/langfuse.mjs';
import * as keycloak from '../lib/records/keycloak.mjs';
import * as k8s from '../lib/records/k8s.mjs';
import { kubectl, logs, portForward, NS } from '../lib/kube.mjs';
import { request } from '../lib/http.mjs';
import { HopError } from '../lib/hop.mjs';

const { U, B, V } = PRINCIPALS;
const J = journey('AT-d', 'journey-d-app');
const SLUG = 'e2e-supplier-portal';
const APP_NS = `app-${DOMAIN}`;
const SCAN_NS = process.env.E2E_SCAN_NAMESPACE ?? 'software-scans';
const TRIVY_VERSION = process.env.E2E_TRIVY_VERSION ?? '0.76.2';
const GRANTED_SYSTEM = 'AT-d supplier helper';
const appUrl = async () => (await portForward(SLUG, Number(process.env.E2E_APP_PORT ?? 80), APP_NS)).url;
const allowed = (e) => e.result === true || e.result?.allow === true;

const files = (lodash) => [
  { path: `apps/${SLUG}/package.json`, content: JSON.stringify({ name: SLUG, version: '1.0.0', private: true, dependencies: { lodash } }, null, 2) },
  { path: `apps/${SLUG}/package-lock.json`, content: JSON.stringify({ name: SLUG, version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: SLUG, version: '1.0.0', dependencies: { lodash } }, 'node_modules/lodash': { version: lodash, resolved: `https://registry.npmjs.org/lodash/-/lodash-${lodash}.tgz` } } }, null, 2) },
  { path: `apps/${SLUG}/index.mjs`, content: "import http from 'node:http';\nhttp.createServer((q, s) => s.end('ok')).listen(8080);\n" },
];

// ---------------------------------------------------------------- steps
const app = () => J.step('app', () => callTool(U, 'create_software', { name: SLUG, domain: DOMAIN, kind: 'code', surface: 'both' }));

async function pushAndScan(lodash) {
  const a = await app();
  const since = isoNow();
  const pushed = await callTool(U, 'push_app_files', { appId: a.id, files: files(lodash), message: `lodash ${lodash}` });
  check(pushed?.sha, 'os-ui', 'push_app_files returns the commit sha', pushed);
  const checks = await waitFor(async () => (await pg.rows('os_governance', `select sha, status, image_digest, detail from commit_checks where sha = '${pushed.sha}' and kind = 'trivy'`)).find((r) => r.status !== 'pending'),
    { component: 'postgres', hop: 'commit_checks', what: `a settled Trivy check for ${pushed.sha}`, timeoutMs: 600000 });
  return { app: a, sha: pushed.sha, since, checks };
}
const vulnerable = () => J.step('vulnerable commit', () => pushAndScan('4.17.20'));
const fixed = () => J.step('fixed commit', async () => { await vulnerable(); return pushAndScan('4.17.21'); });

async function requestAndApprove() {
  const f = await fixed();
  const req = await callTool(U, 'request_deploy', { appId: f.app.id, sha: f.sha });
  const decided = await callTool(B, 'decide_deploy', { requestId: req.requestId ?? req.id, decision: 'approve' });
  return { ...f, req, decided };
}
const deployed = () => J.step('deployed', async () => {
  const r = await requestAndApprove();
  await waitFor(() => k8s.deploymentAvailable(SLUG, APP_NS), { component: 'kubernetes', hop: `deployment ${APP_NS}/${SLUG}`, what: 'Available=True', timeoutMs: 600000 });
  return r;
});

async function viewerCall(systemName) {
  const d = await deployed();
  await stub.reset();
  await stub.loadScript([{ reply: { content: 'Supplier helper answer.' } }]);
  const token = await keycloak.tokenFor(V);
  const res = await request('os-ui', `app agent call ${systemName}`, `${await appUrl()}/api/agents/${encodeURIComponent(systemName)}/run`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: { message: 'Which suppliers are pending?' }, okStatus: [403],
  });
  return { d, res, at: isoNow() };
}

// ---------------------------------------------------------------- 1. scan blocks
J.assertion('d1.1', { hop: `scan Job ran Trivy ${TRIVY_VERSION} against trivy-server and failed on lodash 4.17.20`, record: 'scan Job log (Trivy output) + commit_checks', expectedFail: 'WP-43' }, async () => {
  const { sha, checks } = await vulnerable();
  const log = await logs(`sovereign-os.io/commit=${sha}`, { ns: SCAN_NS });
  check(log.includes(`Version: ${TRIVY_VERSION}`) || log.includes(`trivy ${TRIVY_VERSION}`) || log.includes(`"Version":"${TRIVY_VERSION}"`), 'trivy', `scan log reports Trivy ${TRIVY_VERSION}`, log.slice(0, 300));
  check(/--server\s+http:\/\/trivy-server/.test(log) || /trivy-server/.test(log), 'trivy', 'scan ran in client mode against trivy-server', log.slice(0, 300));
  check(/lodash/.test(log) && /CVE-2021-23337|CVE-2020-28500/.test(log), 'trivy', 'Trivy reports the lodash 4.17.20 CVEs', log.slice(0, 300));
  check(checks.status === 'failed', 'postgres', 'commit_checks(sha) is failed', checks.status);
});

J.assertion('d1.2', { hop: 'deploy approval is refused for the failed sha', record: 'OS refusal + OPA decision log', expectedFail: 'WP-43' }, async () => {
  const { app: a, sha } = await vulnerable();
  let refused = null;
  try {
    const req = await callTool(U, 'request_deploy', { appId: a.id, sha });
    await callTool(B, 'decide_deploy', { requestId: req.requestId ?? req.id, decision: 'approve' });
  } catch (err) { refused = err; }
  check(refused && /scan|commit_checks|vulnerab/i.test(refused.reason ?? ''), 'os-ui', 'approval refused because the scan failed', refused?.reason ?? 'approved');
  const ds = await opa.decisions({ action: 'deploy.approve', sinceMinutes: 30, match: (e) => JSON.stringify(e.input ?? {}).includes(sha) });
  check(ds.length > 0 && ds.every((e) => !allowed(e)), 'opa', 'deploy.approve decisions for the sha are all deny', ds.map((e) => e.result));
});

// ---------------------------------------------------------------- 2. fix passes
J.assertion('d2.1', { hop: 'after the fix commit_checks passes, including trivy image on the runner digest', record: 'scan Job log + commit_checks', expectedFail: 'WP-43' }, async () => {
  const { sha, checks } = await fixed();
  check(checks.status === 'passed', 'postgres', 'commit_checks(fixed sha) passed', checks.status);
  check(/^sha256:[0-9a-f]{64}$/.test(checks.image_digest ?? ''), 'postgres', 'commit_checks records the scanned image digest', checks.image_digest);
  const log = await logs(`sovereign-os.io/commit=${sha}`, { ns: SCAN_NS });
  check(log.includes(checks.image_digest) && /trivy image/.test(log), 'trivy', 'the log shows `trivy image` on that digest', log.slice(0, 300));
});

// ---------------------------------------------------------------- 3. four-eyes approval
J.assertion('d3.1', { hop: 'builder B (not U) approves; OPA deploy.approve allowed', record: 'OPA decision log', expectedFail: 'WP-29' }, async () => {
  const { sha } = await deployed();
  const ds = await opa.decisions({ action: 'deploy.approve', match: (e) => JSON.stringify(e.input ?? {}).includes(sha) && allowed(e) });
  check(ds.length === 1 && ds[0].input?.subject?.id === B && ds[0].input?.resource?.requester !== B, 'opa', `one allowed deploy.approve by ${B} for a request by someone else`, ds.map((e) => e.input?.subject));
});

// ---------------------------------------------------------------- 4. what runs is what was scanned
J.assertion('d4.1', { hop: 'Deployment Available; VulnerabilityReport digest = pod imageID = scanned digest', record: 'Kubernetes + Trivy Operator VulnerabilityReport', expectedFail: 'WP-54' }, async () => {
  const { checks } = await deployed();
  check(await k8s.deploymentAvailable(SLUG, APP_NS), 'kubernetes', 'Deployment Available', false);
  const ids = await k8s.podImageIds(`app.kubernetes.io/name=${SLUG}`, APP_NS);
  check(ids.length && ids.every((id) => id.endsWith(checks.image_digest)), 'kubernetes', 'every pod imageID ends with the scanned digest', ids);
  const reports = (await k8s.vulnerabilityReports(APP_NS)).filter((r) => r.metadata.labels?.['trivy-operator.resource.name'] === SLUG);
  check(reports.some((r) => r.report?.artifact?.digest === checks.image_digest), 'trivy-operator', 'a VulnerabilityReport for that digest', reports.map((r) => r.report?.artifact?.digest));
});

// ---------------------------------------------------------------- 5. viewer
J.assertion('d5.1', { hop: 'viewer logs in through Keycloak client app-<slug> in a browser', record: 'Keycloak login (Playwright)', expectedFail: 'WP-39' }, async () => {
  await deployed();
  let pw;
  try { pw = await import('playwright'); } catch {
    throw new HopError({ component: 'harness', hop: 'playwright', reason: 'playwright is not installed in the harness; the pinned browser login is added with the app identity work', wp: 'WP-39' });
  }
  const browser = await pw.chromium.launch();
  try {
    const page = await browser.newPage();
    const home = await appUrl();
    await page.goto(`${home}/`);
    await page.fill('#username', V);
    await page.fill('#password', process.env.E2E_TEST_USER_PASSWORD ?? 'e2e-test-password');
    await page.click('#kc-login');
    await page.waitForURL((u) => u.href.startsWith(home));
    check(page.url().startsWith(home), 'keycloak', `login through client app-${SLUG} returned to the app`, page.url());
  } finally { await browser.close(); }
});

J.assertion('d5.2', { hop: 'the app calls the granted agent; Langfuse trace userId=<viewer>, tag app:<slug>', record: 'Langfuse Observations v2', expectedFail: 'WP-39' }, async () => {
  const { res } = await viewerCall(GRANTED_SYSTEM);
  check(res.status === 200 && res.data?.traceId, 'os-ui', 'agent call through the app succeeded and names its trace', res.status);
  const obs = await langfuse.observations({ traceId: res.data.traceId });
  check(obs.length && obs.every((o) => o.userId === V), 'langfuse', `every observation has userId=${V}`, [...new Set(obs.map((o) => o.userId))]);
  const root = langfuse.roots(obs)[0];
  check([].concat(root?.tags ?? root?.metadata?.tags ?? []).includes(`app:${SLUG}`), 'langfuse', `trace tagged app:${SLUG}`, root?.tags);
});

// ---------------------------------------------------------------- negative twins
let systemName = GRANTED_SYSTEM;
J.twin('d-twin-1', { disables: 'the app calls a system it has no grant for', record: 'HTTP 403 + OPA decision id', expectedFail: 'WP-29', redReasonMust: /403.*decision/i }, {
  check: async () => {
    const { res } = await viewerCall(systemName);
    if (res.status === 403) {
      const id = res.data?.decisionId;
      const d = id ? await opa.decisionById(id) : null;
      throw new HopError({ component: 'os-ui', hop: 'agent call', reason: `403 with decision ${id ?? 'missing'} ${d ? 'found in OPA log' : 'NOT in OPA log'}` });
    }
    check(res.status === 200, 'os-ui', 'granted call succeeds', res.status);
  },
  disable: async () => { systemName = 'AT-d not granted system'; },
  restore: async () => { systemName = GRANTED_SYSTEM; },
});

const APP_NP = process.env.E2E_APP_NETPOL ?? 'default-deny-egress';
let savedAppNp;
J.twin('d-twin-2', { disables: `NetworkPolicy ${APP_NS}/${APP_NP} removed`, record: 'Calico-enforced TCP probe with the app pod labels', expectedFail: 'WP-54' }, {
  check: async () => {
    await deployed();
    const labels = { 'app.kubernetes.io/name': SLUG };
    const toTrino = await k8s.tcpProbe({ ns: APP_NS, labels, host: `trino.${NS}.svc`, port: 8443 });
    const toOs = await k8s.tcpProbe({ ns: APP_NS, labels, host: `opensearch.${NS}.svc`, port: 9200 });
    check(!toTrino && !toOs, 'calico', 'app pod cannot open TCP to Trino :8443 or OpenSearch :9200', { toTrino, toOs });
  },
  disable: async () => {
    savedAppNp = JSON.parse(await kubectl(['-n', APP_NS, 'get', 'networkpolicy', APP_NP, '-o', 'json']));
    await kubectl(['-n', APP_NS, 'delete', 'networkpolicy', APP_NP]);
  },
  restore: async () => {
    if (!savedAppNp) return;
    const { metadata: { name, namespace, labels }, spec } = savedAppNp;
    await kubectl(['apply', '-f', '-'], { input: JSON.stringify({ apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name, namespace, labels }, spec }) });
  },
});

J.twin('d-twin-3', { disables: 'trivy-server scaled to zero', record: 'commit_checks + OS refusal', expectedFail: 'WP-42', redReasonMust: /unavailable/i }, {
  check: async () => {
    const r = await pushAndScan('4.17.21');
    if (r.checks.status !== 'passed') throw new HopError({ component: 'trivy', hop: 'scan', reason: `${r.checks.status}: ${JSON.stringify(r.checks.detail ?? '').slice(0, 200)}` });
    const req = await callTool(U, 'request_deploy', { appId: r.app.id, sha: r.sha });
    await callTool(B, 'decide_deploy', { requestId: req.requestId ?? req.id, decision: 'approve' });
  },
  disable: async () => { await kubectl(['-n', NS, 'scale', 'deployment/trivy-server', '--replicas=0']); },
  restore: async () => { await kubectl(['-n', NS, 'scale', 'deployment/trivy-server', '--replicas=1']); },
});
