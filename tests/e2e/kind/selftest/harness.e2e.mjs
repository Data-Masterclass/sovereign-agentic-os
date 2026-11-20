/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       acceptance harness (tests/e2e/kind)
 * FEATURE:    The harness proves itself: NetworkPolicies are enforced, S3 works, the model stub
 *             counts, and every record helper reaches its component
 * USER STORY: As the verifier I want the journeys' red to mean "the OS is not there yet", never
 *             "the harness is broken", so the harness's own infrastructure must be green first.
 * ARCHITECTURE:
 *   - NOT expected-fail: these assertions must be green on a healthy harness. A component that
 *     could not start (e.g. on a small laptop) shows here as `failed`, with the reason.
 *   - h1 is itself a negative twin: the probe is OPEN, a deny-all NetworkPolicy must make it CLOSED.
 *     kindnet would leave it OPEN, so this is the proof that Calico enforces policy.
 */
import { journey, check } from '../lib/journey.mjs';
import { kubectl, getJson } from '../lib/kube.mjs';
import { baseUrl, LOCAL } from '../lib/endpoints.mjs';
import { request, basic } from '../lib/http.mjs';
import * as k8s from '../lib/records/k8s.mjs';
import * as s3 from '../lib/records/s3.mjs';
import * as stub from '../lib/records/stub.mjs';
import * as dagster from '../lib/records/dagster.mjs';
import * as trino from '../lib/records/trino.mjs';
import * as osr from '../lib/records/opensearch.mjs';

const J = journey('HARNESS', 'harness self-test');
const PROBE_NS = 'e2e-selftest';

// ---------------------------------------------------------------- h1: Calico enforces NetworkPolicy
const target = () => J.step('probe target', async () => {
  await kubectl(['create', 'namespace', PROBE_NS]).catch(() => {});
  const pod = {
    apiVersion: 'v1', kind: 'Pod', metadata: { name: 'np-target', namespace: PROBE_NS, labels: { app: 'np-target' } },
    spec: { containers: [{ name: 'srv', image: process.env.E2E_PROBE_IMAGE ?? 'busybox:1.36', command: ['sh', '-c', 'nc -lk -p 8080 -e echo ok'], ports: [{ containerPort: 8080 }] }] },
  };
  const svc = { apiVersion: 'v1', kind: 'Service', metadata: { name: 'np-target', namespace: PROBE_NS }, spec: { selector: { app: 'np-target' }, ports: [{ port: 8080 }] } };
  await kubectl(['apply', '-f', '-'], { input: JSON.stringify({ apiVersion: 'v1', kind: 'List', items: [pod, svc] }) });
  await kubectl(['-n', PROBE_NS, 'wait', '--for=condition=Ready', 'pod/np-target', '--timeout=180s'], { timeoutMs: 200000 });
});

J.assertion('h0.1', { hop: 'Calico is the CNI and its node agent is Ready', record: 'kube-system DaemonSet calico-node' }, async () => {
  const ds = await getJson('daemonset', 'calico-node', 'kube-system');
  check(ds.status.numberReady >= 1 && ds.status.numberReady === ds.status.desiredNumberScheduled, 'calico', 'calico-node ready on every node', ds.status);
  const kindnet = await getJson('daemonset', null, 'kube-system');
  check(!kindnet.items.some((d) => d.metadata.name === 'kindnet'), 'kind', 'kindnet is not installed (disableDefaultCNI)', kindnet.items.map((d) => d.metadata.name));
});

J.twin('h1', { disables: 'deny-all ingress NetworkPolicy on the target', record: 'TCP probe through Calico' }, {
  check: async () => {
    await target();
    const open = await k8s.tcpProbe({ ns: PROBE_NS, labels: { app: 'np-client' }, host: 'np-target', port: 8080 });
    check(open, 'calico', 'probe reaches the target', 'CLOSED');
  },
  disable: () => kubectl(['apply', '-f', '-'], { input: JSON.stringify({ apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name: 'deny-all', namespace: PROBE_NS }, spec: { podSelector: { matchLabels: { app: 'np-target' } }, policyTypes: ['Ingress'] } }) }),
  restore: () => kubectl(['-n', PROBE_NS, 'delete', 'networkpolicy', 'deny-all', '--ignore-not-found']),
});

// ---------------------------------------------------------------- h2: SeaweedFS S3
J.assertion('h2.1', { hop: 'chart buckets exist in SeaweedFS', record: 'SeaweedFS filer /buckets' }, async () => {
  const buckets = (await s3.list('')).map((p) => p.split('/').at(-1));
  for (const b of ['langfuse', 'lakehouse', 'sandbox', 'files']) check(buckets.includes(b), 'seaweedfs', `bucket ${b} exists`, buckets);
});

J.assertion('h2.2', { hop: 'an S3 SigV4 PUT is readable back through the filer', record: 'SeaweedFS S3 gateway + filer' }, async () => {
  const key = `e2e-selftest/${Date.now()}.json`;
  const body = JSON.stringify({ ok: true, key });
  const status = await s3.putObject('sandbox', key, body);
  check(status === 200, 'seaweedfs', 'S3 PUT 200', status);
  const back = await s3.getJson('sandbox', key);
  check(back.key === key, 'seaweedfs', 'object content round-trips', back);
});

// ---------------------------------------------------------------- h3: the model stub counts, LiteLLM routes to it
J.assertion('h3.1', { hop: 'stub counts requests and refuses an exhausted script', record: 'model stub /__stub/stats' }, async () => {
  await stub.reset();
  await stub.loadScript([{ reply: { content: 'one' } }]);
  const url = `${await baseUrl('stub')}/v1/chat/completions`;
  const r1 = await request('model-stub', 'chat', url, { method: 'POST', body: { model: 'x', messages: [{ role: 'user', content: 'hi' }] } });
  check(r1.data.choices[0].message.content === 'one', 'model-stub', 'scripted reply', r1.data);
  const r2 = await request('model-stub', 'chat', url, { method: 'POST', body: { model: 'x', messages: [{ role: 'user', content: 'again' }] }, okStatus: [409] });
  check(r2.status === 409 && r2.data.error.code === 'stub_script_exhausted', 'model-stub', 'exhausted script is a typed 409', r2.data);
  check(await stub.chatCount() === 1, 'model-stub', 'exactly one answered chat call counted', await stub.chatCount());
});

J.assertion('h3.2', { hop: 'LiteLLM (production model list) routes sovereign-default to the stub', record: 'model stub request log' }, async () => {
  await stub.reset();
  await stub.loadScript([{ reply: { content: 'via litellm' } }]);
  const r = await request('litellm', 'chat', `${await baseUrl('litellm')}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${LOCAL.litellmMasterKey}`, 'content-type': 'application/json' },
    body: { model: 'sovereign-default', messages: [{ role: 'user', content: 'hello' }] }, timeoutMs: 60000,
  });
  check(r.data.choices?.[0]?.message?.content === 'via litellm', 'litellm', 'LiteLLM returned the stub answer', r.data);
  check(await stub.chatCount() === 1, 'model-stub', 'the stub counted the call that came through LiteLLM', await stub.chatCount());
});

// ---------------------------------------------------------------- h4: every record helper reaches its component
J.assertion('h4.dagster', { hop: 'Dagster GraphQL answers', record: 'Dagster webserver /graphql' }, async () => {
  const d = await dagster.gql('{ version }');
  check(typeof d.version === 'string', 'dagster', 'GraphQL returns a version', d);
});
J.assertion('h4.trino', { hop: 'Trino client protocol answers and system.runtime.queries is readable', record: 'Trino /v1/statement' }, async () => {
  const r = await trino.query('select 1 as one');
  check(r.rows[0]?.one === 1, 'trino', 'select 1', r.rows);
  const q = await trino.runtimeQueries({ sinceMinutes: 10 });
  check(Array.isArray(q), 'trino', 'system.runtime.queries readable', q);
});
J.assertion('h4.opensearch', { hop: 'OpenSearch answers', record: 'OpenSearch /' }, async () => {
  const r = await osr.os('/');
  check(r.version?.number, 'opensearch', 'cluster info has a version', r);
});
J.assertion('h4.langfuse', { hop: 'Langfuse answers its public health API', record: 'Langfuse /api/public/health' }, async () => {
  const r = await request('langfuse', 'health', `${await baseUrl('langfuse')}/api/public/health`, { headers: { authorization: basic(LOCAL.langfusePublicKey, LOCAL.langfuseSecretKey) } });
  check(r.status === 200, 'langfuse', 'health 200', r.status);
});
J.assertion('h4.opa', { hop: 'OPA answers /health', record: 'OPA /health' }, async () => {
  const r = await request('opa', 'health', `${await baseUrl('opa')}/health`);
  check(r.status === 200, 'opa', 'health 200', r.status);
});
J.assertion('h4.docling', { hop: 'Docling-serve answers /health', record: 'docling-serve /health' }, async () => {
  const r = await request('docling', 'health', `${await baseUrl('docling')}/health`, { timeoutMs: 60000 });
  check(r.status === 200, 'docling', 'health 200', r.status);
});
