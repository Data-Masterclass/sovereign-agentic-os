/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       acceptance harness (tests/e2e/kind)
 * FEATURE:    AT-f journey-f-eject.e2e — every artifact runs on its native open-source tool from a
 *             plain clone of the domain repo, with the OS layer deleted and no os-ui running
 * USER STORY: As the owner I want proof of my acceptance rule: what the OS produced is dbt,
 *             Dagster, MetricFlow, LangGraph, OPA, Kubernetes, Vega-Lite and OKF code that builds,
 *             runs and gives the SAME answers as the OS, after the OS is switched off.
 * ARCHITECTURE:
 *   - Authoritative: 11 §4.2 (AT-f) and §2 rows (d); 10 "Artifact contract amendments" (WP-02, WP-48).
 *   - Phase 1 (OS up): capture the OS's own answers to compare against: gold row counts, metric
 *     values for viewer V, an agent run's node sequence (from Langfuse), a guardrail decision.
 *   - Phase 2 (OS down): clone at the live ref, delete the OS layer, scale os-ui + os-ui-worker to 0,
 *     run each native command in the chart-pinned image inside kind (records/eject.mjs).
 *   - after(): os-ui and the worker are scaled back up, so the file can run before or after others.
 */
import { after } from 'node:test';
import { appendFile, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { journey, check } from '../lib/journey.mjs';
import { PRINCIPALS, DOMAIN, createTraceId, waitFor } from '../lib/common.mjs';
import { callTool } from '../lib/os-driver.mjs';
import { chartImage } from '../lib/chart.mjs';
import * as git from '../lib/records/git.mjs';
import * as trino from '../lib/records/trino.mjs';
import * as opa from '../lib/records/opa.mjs';
import * as stub from '../lib/records/stub.mjs';
import * as langfuse from '../lib/records/langfuse.mjs';
import * as k8s from '../lib/records/k8s.mjs';
import { stripOsLayer, ejectPod, listNative, exists } from '../lib/records/eject.mjs';
import { kubectl, getJson, NS } from '../lib/kube.mjs';
import { HopError } from '../lib/hop.mjs';

const { U, V } = PRINCIPALS;
const J = journey('AT-f', 'journey-f-eject');
const DOMAINS = (process.env.E2E_EJECT_DOMAINS ?? DOMAIN).split(',');
const LIVE_REF = process.env.E2E_EJECT_REF ?? 'refs/tags/live/domain';
const OS_DEPLOYMENTS = ['os-ui', 'os-ui-worker'];
const TRINO_ENV = { TRINO_HOST: `trino.${NS}.svc`, TRINO_PORT: 8080, TRINO_USER: process.env.E2E_EJECT_TRINO_USER ?? 'svc-dagster-runner', OS_PRINCIPAL: U };

// ---------------------------------------------------------------- phase 1: the OS's answers (OS up)
const osAnswers = () => J.step('OS answers', async () => {
  const datasets = (await callTool(U, 'list_datasets', { domain: DOMAIN })).items ?? [];
  const gold = datasets.filter((d) => d.layer === 'gold');
  check(gold.length > 0, 'os-ui', `the ${DOMAIN} domain has gold datasets to eject`, datasets.length);
  const rowCounts = Object.fromEntries(gold.map((d) => [d.table, d.lastRowCount]));
  const metrics = (await callTool(U, 'list_metrics', { domain: DOMAIN })).items ?? [];
  const metricValues = {};
  for (const m of metrics) metricValues[m.name] = (await callTool(V, 'query_metric', { metricId: m.id })).rows?.[0]?.value;
  const systems = (await callTool(U, 'list_agent_systems', { domain: DOMAIN })).items ?? [];
  let nodeSequence = null;
  if (systems[0]) {
    await stub.reset();
    await stub.loadScript([{ reply: { content: 'eject comparison run' } }]);
    const run = await callTool(U, 'run_agent_system', { systemId: systems[0].id, message: 'eject comparison' });
    const obs = await waitFor(async () => { const o = await langfuse.observations({ traceId: createTraceId(run.runId) }); return o.length ? o : null; },
      { component: 'langfuse', hop: 'observations v2', what: 'the comparison run trace' });
    nodeSequence = obs.filter((o) => o.metadata?.langgraph_node).sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime)).map((o) => o.metadata.langgraph_node);
  }
  const guardrailDecisions = await opa.decisions({ path: 'os/guardrails', sinceMinutes: 1440 });
  return { rowCounts, metricValues, systems, nodeSequence, guardrailDecisions };
});

// ---------------------------------------------------------------- phase 2: clone, strip, switch the OS off
async function osDown() {
  for (const d of OS_DEPLOYMENTS) await kubectl(['-n', NS, 'scale', `deployment/${d}`, '--replicas=0']).catch(() => {});
  await waitFor(async () => (await getJson('pods', null, NS)).items.filter((p) => OS_DEPLOYMENTS.includes(p.metadata.labels?.['app.kubernetes.io/component'])).length === 0,
    { component: 'kubernetes', hop: 'scale os-ui to 0', what: 'no os-ui / os-ui-worker pod', timeoutMs: 180000 });
}
after(async () => {
  for (const d of OS_DEPLOYMENTS) await kubectl(['-n', NS, 'scale', `deployment/${d}`, '--replicas=1']).catch(() => {});
});

async function ejected(domain, mutate) {
  await osAnswers();
  const dir = await git.clone(domain);
  const refs = await git.refs(dir, LIVE_REF.replace(/^refs\/tags\/.*/, 'refs/tags/'));
  const live = refs.find((r) => r.ref === LIVE_REF);
  if (!live) throw new HopError({ component: 'git', hop: `live ref ${LIVE_REF}`, reason: `no ${LIVE_REF} in ${domain} (refs: ${refs.map((r) => r.ref).join(', ') || 'none'})`, wp: 'WP-51' });
  await git.git(['checkout', '--quiet', live.sha], dir);
  const removed = await stripOsLayer(dir);
  if (mutate) await mutate(dir);
  return { dir, sha: live.sha, removed };
}
const base = (domain) => J.step(`ejected ${domain}`, async () => { const e = await ejected(domain); await osDown(); return e; });

async function dagsterPod(name, dir) {
  const pod = await ejectPod(name, await chartImage('dagster.dagsterWebserver.image'), { env: TRINO_ENV });
  await pod.copy(dir);
  return pod;
}

// ---------------------------------------------------------------- positive assertions
async function dbtBuild(dir) {
  const pod = await dagsterPod(`e2e-eject-dbt-${Date.now().toString(36)}`, dir);
  try { return await pod.run('dbt build --profiles-dir . --no-partial-parse', 'dbt build'); } finally { await pod.remove(); }
}

for (const domain of DOMAINS) {
  J.assertion(`f1.${domain}`, { hop: `dbt build green on ${domain}; Trino row counts equal the OS's`, record: 'dbt build output + Trino count(*)', expectedFail: 'WP-49' }, async () => {
    const { dir } = await base(domain);
    const out = await dbtBuild(dir);
    check(/Completed successfully/.test(out) && !/\bERROR=[1-9]/.test(out), 'dbt', 'dbt build completed with no errors', out.split('\n').slice(-5).join(' | '));
    const { rowCounts } = await osAnswers();
    for (const [table, n] of Object.entries(rowCounts)) {
      const r = await trino.query(`select count(*) as n from iceberg.${domain}.${table}`, { hop: `count ${table}` });
      check(Number(r.rows[0].n) === Number(n), 'trino', `${table}: Trino count equals the OS's last value ${n}`, r.rows[0].n);
    }
  });

  J.assertion(`f2.${domain}`, { hop: 'dagster definitions validate + asset materialize SUCCESS in an ejected dagster', record: 'dagster CLI output', expectedFail: 'WP-49' }, async () => {
    const { dir } = await base(domain);
    check(await exists(dir, 'orchestration/definitions.py'), 'git', 'orchestration/definitions.py is committed', 'missing');
    const pod = await dagsterPod(`e2e-eject-dagster-${Date.now().toString(36)}`, dir);
    try {
      const v = await pod.run('dagster definitions validate -f orchestration/definitions.py', 'dagster definitions validate');
      check(/validated successfully|Validation successful/i.test(v), 'dagster', 'definitions validate', v.slice(-300));
      const { rowCounts } = await osAnswers();
      const asset = Object.keys(rowCounts)[0];
      const m = await pod.run(`DAGSTER_HOME=$(mktemp -d) dagster asset materialize -f orchestration/definitions.py --select ${asset}`, 'dagster asset materialize');
      check(/RUN_SUCCESS|Finished execution of run/.test(m), 'dagster', `materialize ${asset} ends RUN_SUCCESS`, m.slice(-300));
    } finally { await pod.remove(); }
  });

  J.assertion(`f3.${domain}`, { hop: "mf query per metric equals the OS tile value for the same viewer", record: 'MetricFlow CLI output vs OS answer', expectedFail: 'WP-20' }, async () => {
    const { dir } = await base(domain);
    const { metricValues } = await osAnswers();
    check(Object.keys(metricValues).length > 0, 'os-ui', 'the domain has metrics', 0);
    const pod = await dagsterPod(`e2e-eject-mf-${Date.now().toString(36)}`, dir);
    try {
      await pod.run('dbt parse --profiles-dir .', 'dbt parse');
      for (const [name, osValue] of Object.entries(metricValues)) {
        const out = await pod.run(`OS_PRINCIPAL=${V} mf query --metrics ${name} --csv /tmp/${name}.csv && tail -1 /tmp/${name}.csv`, `mf query ${name}`);
        const value = out.trim().split('\n').at(-1).split(',').at(-1);
        check(Number(value) === Number(osValue), 'metricflow', `${name}: mf query value equals the OS value ${osValue}`, value);
      }
    } finally { await pod.remove(); }
  });

  J.assertion(`f4.${domain}`, { hop: 'node run.mjs --stub-tools reaches END with the OS run\'s node sequence', record: 'LangGraph run output vs Langfuse node sequence', expectedFail: 'WP-53' }, async () => {
    const { dir } = await base(domain);
    const { nodeSequence, systems } = await osAnswers();
    check(systems.length > 0 && nodeSequence?.length, 'langfuse', 'an OS run node sequence to compare with', nodeSequence);
    const graphs = await listNative(dir, /^agents\/[^/]+\/run\.mjs$/);
    check(graphs.length > 0, 'git', 'agents/<id>/run.mjs committed', 0);
    const pod = await ejectPod(`e2e-eject-node-${Date.now().toString(36)}`, await chartImage('marts.image'), { env: { OPENAI_BASE_URL: `http://mock-model.${NS}.svc:8080/v1` } });
    try {
      await pod.copy(dir);
      await stub.reset();
      await stub.loadScript([{ reply: { content: 'eject comparison run' } }]);
      const out = await pod.run(`node ${graphs[0]} --stub-tools --print-nodes 'eject comparison'`, 'langgraph run.mjs');
      const seq = out.trim().split('\n').filter((l) => l.startsWith('node:')).map((l) => l.slice(5).trim());
      check(seq.at(-1) === '__end__' || /END/.test(out), 'langgraph', 'the graph reached END', out.slice(-200));
      check(JSON.stringify(seq.filter((s) => s !== '__end__')) === JSON.stringify(nodeSequence), 'langgraph', 'same node sequence as the OS run', { ejected: seq, os: nodeSequence });
    } finally { await pod.remove(); }
  });

  J.assertion(`f5.${domain}`, { hop: 'opa eval on every guardrails.json gives the OS decision for the fixture call', record: 'opa eval vs OPA decision log', expectedFail: 'WP-30' }, async () => {
    const { dir } = await base(domain);
    const files = await listNative(dir, /^knowledge\/workflows\/[^/]+\/guardrails\.json$/);
    check(files.length > 0, 'git', 'knowledge/workflows/*/guardrails.json committed', 0);
    const { guardrailDecisions } = await osAnswers();
    check(guardrailDecisions.length > 0, 'opa', 'OS guardrail decisions to compare with', 0);
    const pod = await ejectPod(`e2e-eject-opa-${Date.now().toString(36)}`, await chartImage('opa.image'));
    try {
      await pod.copy(dir);
      for (const d of guardrailDecisions.slice(0, 5)) {
        await writeFile(join(dir, 'input.json'), JSON.stringify(d.input));
        await pod.copy(dir);
        const out = await pod.run(`opa eval -f json -d /work/policies -d ${files.map((f) => `/work/${f}`).join(' -d ')} -i /work/input.json 'data.${d.path.replaceAll('/', '.')}'`, 'opa eval');
        const got = JSON.parse(out).result?.[0]?.expressions?.[0]?.value;
        check(JSON.stringify(got) === JSON.stringify(d.result), 'opa', `decision ${d.decision_id}: ejected eval equals the logged result`, { ejected: got, os: d.result });
      }
    } finally { await pod.remove(); await rm(join(dir, 'input.json'), { force: true }); }
  });

  J.assertion(`f6.${domain}`, { hop: 'kubectl apply -k apps/<slug>/deploy brings the Deployment to Available', record: 'Kubernetes Deployment status', expectedFail: 'WP-54' }, async () => {
    const { dir } = await base(domain);
    const kustomizations = await listNative(dir, /^apps\/[^/]+\/deploy\/kustomization\.ya?ml$/);
    check(kustomizations.length > 0, 'git', 'apps/<slug>/deploy/kustomization.yaml committed', 0);
    const ns = 'e2e-eject-apps';
    await kubectl(['create', 'namespace', ns]).catch(() => {});
    for (const k of kustomizations) {
      const slug = k.split('/')[1];
      await kubectl(['-n', ns, 'apply', '-k', join(dir, 'apps', slug, 'deploy')]);
      await waitFor(() => k8s.deploymentAvailable(slug, ns), { component: 'kubernetes', hop: `deployment ${ns}/${slug}`, what: 'Available=True', timeoutMs: 300000 });
    }
  });

  J.assertion(`f7.${domain}`, { hop: 'vl-convert renders every Vega-Lite panel', record: 'vl-convert output', expectedFail: 'WP-52' }, async () => {
    const { dir } = await base(domain);
    const panels = await listNative(dir, /\.vl\.json$/);
    check(panels.length > 0, 'git', 'dashboards/**/*.vl.json committed', 0);
    const image = process.env.E2E_VLCONVERT_IMAGE;
    if (!image) throw new HopError({ component: 'vl-convert', hop: 'image pin', reason: 'no pinned vl-convert image (E2E_VLCONVERT_IMAGE); the dashboard work pins it', wp: 'WP-52' });
    const pod = await ejectPod(`e2e-eject-vl-${Date.now().toString(36)}`, image);
    try {
      await pod.copy(dir);
      for (const p of panels) {
        const out = await pod.run(`vl-convert vl2svg --input /work/${p} --output /tmp/panel.svg && wc -c < /tmp/panel.svg`, `vl-convert ${p}`);
        check(Number(out.trim()) > 0, 'vl-convert', `${p} rendered to a non-empty SVG`, out);
      }
    } finally { await pod.remove(); }
  });

  J.assertion(`f8.${domain}`, { hop: 'OKF v0.3 validation passes for knowledge/', record: 'OKF validate.py output', expectedFail: 'WP-44' }, async () => {
    const { dir } = await base(domain);
    check(await exists(dir, 'knowledge'), 'git', 'knowledge/ committed (OKF bundle)', 'missing');
    const validator = process.env.E2E_OKF_VALIDATOR;
    if (!validator) throw new HopError({ component: 'okf', hop: 'validate.py pin', reason: 'no pinned OKF v0.3 validate.py (E2E_OKF_VALIDATOR)', wp: 'WP-44' });
    const pod = await dagsterPod(`e2e-eject-okf-${Date.now().toString(36)}`, dir);
    try {
      const out = await pod.run(`python ${validator} knowledge`, 'okf validate');
      check(/valid|OK/i.test(out) && !/error/i.test(out), 'okf', 'validate.py reports the bundle valid', out.slice(-300));
    } finally { await pod.remove(); }
  });
}

// ---------------------------------------------------------------- negative twins (11 §4.2)
const D0 = DOMAINS[0];
let dropGold = false;
J.twin('f-twin-1', { disables: 'one native model file deleted (models/gold/<x>.sql)', record: 'dbt build output', expectedFail: 'WP-49' }, {
  check: async () => {
    const e = await ejected(D0, async (dir) => {
      if (!dropGold) return;
      const [first] = await listNative(dir, /^models\/gold\/[^/]+\.sql$/);
      if (!first) throw new HopError({ component: 'git', hop: 'models/gold', reason: 'no gold model to delete' });
      await rm(join(dir, first));
    });
    await osDown();
    const out = await dbtBuild(e.dir);
    check(/Completed successfully/.test(out) && !/\bERROR=[1-9]/.test(out), 'dbt', 'dbt build green', out.split('\n').slice(-3).join(' | '));
    const { rowCounts } = await osAnswers();
    for (const table of Object.keys(rowCounts)) check(out.includes(table), 'dbt', `dbt built ${table}`, 'not in build output');
  },
  disable: async () => { dropGold = true; },
  restore: async () => { dropGold = false; },
});

let osDependency = false;
J.twin('f-twin-2', { disables: 'definitions.py made to read os/schedules.yml (an OS-only file)', record: 'dagster definitions validate', expectedFail: 'WP-49' }, {
  check: async () => {
    const e = await ejected(D0, async (dir) => {
      if (osDependency) await appendFile(join(dir, 'orchestration/definitions.py'), "\n_os_schedules = open('os/schedules.yml').read()\n");
    });
    await osDown();
    const pod = await dagsterPod(`e2e-eject-twin2-${Date.now().toString(36)}`, e.dir);
    try {
      const v = await pod.run('dagster definitions validate -f orchestration/definitions.py', 'dagster definitions validate');
      check(/validated successfully|Validation successful/i.test(v), 'dagster', 'definitions validate', v.slice(-300));
    } finally { await pod.remove(); }
  },
  disable: async () => { osDependency = true; },
  restore: async () => { osDependency = false; },
});

let invalidMetricYaml = false;
J.twin('f-twin-3', { disables: 'semantic YAML made invalid while the OS keeps serving the metric', record: 'mf query vs OS answer', expectedFail: 'WP-20' }, {
  check: async () => {
    for (const d of OS_DEPLOYMENTS) await kubectl(['-n', NS, 'scale', `deployment/${d}`, '--replicas=1']);
    await kubectl(['-n', NS, 'rollout', 'status', 'deployment/os-ui', '--timeout=300s'], { timeoutMs: 320000 });
    if (invalidMetricYaml) {
      const dir = await git.clone(D0);
      const [sm] = await listNative(dir, /^models\/.*semantic.*\.ya?ml$/);
      if (!sm) throw new HopError({ component: 'git', hop: 'semantic models', reason: 'no semantic model YAML to corrupt' });
      await writeFile(join(dir, sm), (await readFile(join(dir, sm), 'utf8')).replace(/measures:/, 'measures_broken:'));
      await git.git(['-c', `user.name=${U}`, '-c', `user.email=${U}@e2e.local`, 'commit', '-qam', 'e2e: invalid semantic YAML'], dir);
      await git.git(['push', '-q', 'origin', 'HEAD'], dir);
    }
    const metrics = (await callTool(U, 'list_metrics', { domain: D0 })).items ?? [];
    check(metrics.length > 0, 'os-ui', 'a metric to compare', 0);
    const osValue = (await callTool(V, 'query_metric', { metricId: metrics[0].id })).rows?.[0]?.value;
    const e = await ejected(D0);
    await osDown();
    const pod = await dagsterPod(`e2e-eject-twin3-${Date.now().toString(36)}`, e.dir);
    try {
      await pod.run('dbt parse --profiles-dir .', 'dbt parse');
      const out = await pod.run(`OS_PRINCIPAL=${V} mf query --metrics ${metrics[0].name} --csv /tmp/m.csv && tail -1 /tmp/m.csv`, 'mf query');
      check(Number(out.trim().split(',').at(-1)) === Number(osValue), 'metricflow', 'mf query equals the OS value', { mf: out.trim(), os: osValue });
    } finally { await pod.remove(); }
  },
  disable: async () => { invalidMetricYaml = true; },
  restore: async () => {
    invalidMetricYaml = false;
    const dir = await git.clone(D0);
    const [head] = (await git.git(['log', '-1', '--format=%s'], dir)).split('\n');
    if (head === 'e2e: invalid semantic YAML') {
      await git.git(['-c', `user.name=${U}`, '-c', `user.email=${U}@e2e.local`, 'revert', '--no-edit', 'HEAD'], dir);
      await git.git(['push', '-q', 'origin', 'HEAD'], dir);
    }
  },
});
