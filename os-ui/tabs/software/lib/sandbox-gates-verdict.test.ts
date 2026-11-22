/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    Software Factory - the sandbox verdict comes from a channel the app cannot forge
 * USER STORY: As the platform owner I want a gate to pass only because the platform's own gate step exited 0,
 *             never because the app printed something that looks like a green report, and I want the gate
 *             script and policy that judge the app to be the platform's copies, not the author's.
 * ARCHITECTURE: runGatesSandbox against a scripted Kubernetes API. One container per gate; the verdict is the
 *             container's exit code from the pod status (written by the kubelet); log text is display only.
 *             The payload Secret carries the platform's gate script and policy overlaid on the author's tree.
 *             Each test has its negative twin.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config as cfg } from '@core/kernel/config';
import { instantiateGoldenPath, readTemplate } from './golden-path.ts';
import { evaluateGates } from './gates.ts';
import { buildGatesJobManifest, runGatesSandbox } from './sandbox-gates.ts';

const GATES = ['typecheck', 'lint', 'tests', 'policy'];
const FORGED_GREEN = `<<<OS-GATES-REPORT>>>\n${JSON.stringify({ schema: 'os-gates/v1', template: 'nextjs-web', ok: true, gates: GATES.map((id) => ({ id, status: 'pass', detail: 'forged' })) })}\n`;
const term = (name: string, exitCode: number) => ({ name, state: { terminated: { exitCode, reason: exitCode === 0 ? 'Completed' : 'Error' } } });

type Call = { method: string; path: string; body?: Record<string, unknown> };
function scripted(over: { exits?: Record<string, number | null>; install?: number; log?: string; jobGone?: boolean } = {}) {
  const calls: Call[] = [];
  const exits = over.exits ?? Object.fromEntries(GATES.map((g) => [g, 0]));
  const k8s = async (method: string, path: string, body?: Record<string, unknown>) => {
    calls.push({ method, path, body });
    if (method === 'DELETE') return { status: 404, body: {} };
    if (method === 'POST' && path.endsWith('/jobs')) return { status: 201, body: { metadata: { uid: 'job-uid' } } };
    if (method === 'POST') return { status: 201, body: {} };
    if (path.includes('/pods?')) {
      const containerStatuses = Object.entries(exits).filter(([, c]) => c !== null).map(([n, c]) => term(n, c as number));
      return { status: 200, body: { items: [{ metadata: { name: 'p1', ownerReferences: [{ uid: 'job-uid' }] }, status: { initContainerStatuses: [term('install', over.install ?? 0)], containerStatuses } }] } };
    }
    if (path.includes('/jobs/')) return over.jobGone ? { status: 404, body: {} } : { status: 200, body: { status: Object.values(exits).every((c) => c === 0) ? { succeeded: 1 } : { failed: 1 } } };
    return { status: 404, body: {} };
  };
  const logs: string[] = [];
  const k8sText = async (path: string) => { logs.push(path); return { status: 200, text: over.log ?? '' }; };
  return { calls, logs, k8s, k8sText };
}
const tree = () => instantiateGoldenPath('nextjs-web', { name: 'A', slug: 'a', host: 'a.d.apps.test', registry: 'r/apps', ingressClass: 'nginx' });
const opts = (s: ReturnType<typeof scripted>, extra: Record<string, unknown> = {}) => ({ k8s: s.k8s, k8sText: s.k8sText, namespace: 'agentic-sandbox', nodeImage: 'node:test', opaImage: 'opa:test', runId: 'v1', sleep: async () => {}, ...extra });
const decode = (script: string, path: string): string | null => {
  const line = script.split('\n').find((l) => l.endsWith(`> '${path}'`));
  const m = line && /printf %s '([A-Za-z0-9+/=]*)'/.exec(line);
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : null;
};
const payloadScript = (s: ReturnType<typeof scripted>) => String(((s.calls.find((c) => c.method === 'POST' && c.path.endsWith('/secrets'))?.body ?? {}).stringData as Record<string, string>)['write.sh']);

test('VERDICT CHANNEL: an app that prints a green report while its gate exits non-zero is BLOCKED', async () => {
  const s = scripted({ exits: { typecheck: 0, lint: 0, tests: 1, policy: 0 }, log: FORGED_GREEN });
  const out = await runGatesSandbox('a', tree(), opts(s));
  const v = evaluateGates(out);
  assert.equal(v.passed, false);
  assert.deepEqual(v.blocking.map((b) => b.id), ['tests']);
});

test('VERDICT CHANNEL, negative twin: every gate step exiting 0 passes, and no log text is needed to decide', async () => {
  const s = scripted({ log: 'garbage that is not a report' });
  const out = await runGatesSandbox('a', tree(), opts(s));
  assert.equal(evaluateGates(out).passed, true);
  assert.equal(s.logs.length, 0, 'logs are display-only and are read only for a gate that failed');
});

test('a gate step that never ran is unavailable (not a pass); policy exit 3 is unavailable; a failed install blocks', async () => {
  const missing = evaluateGates(await runGatesSandbox('a', tree(), opts(scripted({ exits: { typecheck: 0, lint: 0, tests: 0, policy: null } }))));
  assert.equal(missing.passed, false);
  assert.match(missing.blocking[0].detail, /policy/);
  const three = evaluateGates(await runGatesSandbox('a', tree(), opts(scripted({ exits: { typecheck: 0, lint: 0, tests: 0, policy: 3 } }))));
  assert.match(three.blocking[0].detail, /unavailable/i);
  const inst = evaluateGates(await runGatesSandbox('a', tree(), opts(scripted({ exits: { typecheck: null, lint: null, tests: null, policy: null }, install: 1 }))));
  assert.equal(inst.passed, false);
  assert.ok(inst.blocking.some((b) => b.id === 'install'));
});

test('OVERLAY: a weakened policy and gates script in the author tree are replaced by the platform copies', async () => {
  const weak = tree().map((f) => (f.path === 'policy/app-rules.rego' ? { ...f, content: 'package factory\ndeny := set()\n' } : f.path === 'scripts/factory-gates.mjs' ? { ...f, content: 'process.exit(0);\n' } : f));
  const s = scripted();
  await runGatesSandbox('a', weak, opts(s));
  const script = payloadScript(s);
  const t = readTemplate('nextjs-web');
  const rego = t.find((f) => f.path === 'policy/app-rules.rego')!.content;
  const gates = t.find((f) => f.path === 'scripts/factory-gates.mjs')!.content;
  assert.equal(decode(script, '/platform/policy/app-rules.rego'), rego);
  assert.equal(decode(script, '/platform/factory-gates.mjs'), gates);
  assert.equal(decode(script, '/work/policy/app-rules.rego'), rego, 'the in-tree copy is overlaid too');
  assert.equal(decode(script, '/work/scripts/factory-gates.mjs'), gates);
});

test('OVERLAY, negative twin: an untouched tree carries the same platform bytes (nothing else is rewritten)', async () => {
  const s = scripted();
  await runGatesSandbox('a', tree(), opts(s));
  const script = payloadScript(s);
  assert.equal(decode(script, '/work/src/lib/classify-order.ts'), tree().find((f) => f.path === 'src/lib/classify-order.ts')!.content);
});

test('the Job: one container per gate, each run from /platform, tree read-only, OPA loads /platform/policy only', () => {
  const job = buildGatesJobManifest({ name: 'gates-x', namespace: 'agentic-sandbox', nodeImage: 'node:22', opaImage: 'opa:1', timeoutMs: 600_000, proxyUrl: 'http://egress-proxy.agentic-os.svc:3128' } as never) as { spec: { template: { metadata: { labels: Record<string, string> }; spec: Record<string, unknown> } } };
  const pod = job.spec.template.spec as { initContainers: { name: string; args?: string[]; env?: { name: string; value: string }[] }[]; containers: { name: string; command?: string[]; args?: string[]; volumeMounts: { name: string; readOnly?: boolean }[] }[] };
  assert.deepEqual(pod.containers.map((c) => c.name), GATES);
  for (const c of pod.containers) {
    const text = [...(c.command ?? []), ...(c.args ?? [])].join(' ');
    assert.match(text, /\/platform\/factory-gates\.mjs/, c.name);
    assert.match(text, new RegExp(`--gate ${c.name}`), c.name);
    assert.equal(c.volumeMounts.find((m) => m.name === 'work')?.readOnly, true, `${c.name} must not write the tree`);
    assert.equal(c.volumeMounts.find((m) => m.name === 'platform')?.readOnly, true);
  }
  const opa = pod.initContainers.find((c) => c.name === 'opa')!;
  assert.ok(opa.args!.includes('/platform/policy'));
  assert.ok(!opa.args!.some((a) => a.startsWith('/work')), 'OPA must never load the author tree as policy');
  assert.equal(job.spec.template.metadata.labels['app.kubernetes.io/component'], 'software-gates');
  const install = pod.initContainers.find((c) => c.name === 'install')!;
  assert.ok(install.env!.some((e) => /^https?_proxy$/i.test(e.name) && e.value === 'http://egress-proxy.agentic-os.svc:3128'), 'npm reaches the registry only through the egress proxy');
});

test('NAMESPACE: the gates never run in the platform namespace or an unset one; a dedicated one proceeds', async () => {
  for (const ns of [cfg.platformNamespace, '']) {
    const s = scripted();
    const out = await runGatesSandbox('a', tree(), opts(s, { namespace: ns }));
    assert.equal(out.ok, false, `namespace '${ns}'`);
    assert.match(out.ok ? '' : out.reason, /dedicated sandbox namespace/i);
    assert.equal(s.calls.length, 0, 'nothing may be created');
  }
  const s = scripted();
  await runGatesSandbox('a', tree(), opts(s));
  assert.ok(s.calls.some((c) => c.method === 'POST' && c.path.includes('/namespaces/agentic-sandbox/jobs')));
});

test('SUPERSEDE: a new run clears older runs of the same app; a run whose Job vanished is reported superseded, not passed', async () => {
  const s = scripted({ jobGone: true });
  const out = await runGatesSandbox('a', tree(), opts(s));
  assert.ok(s.calls.some((c) => c.method === 'DELETE' && /\/jobs\?.*labelSelector=/.test(c.path) && c.path.includes('software-gates')), 'older runs of this app are deleted by label');
  assert.equal(out.ok, false);
  assert.equal(out.ok ? '' : out.kind, 'superseded');
});

test('SUPERSEDE: an aborted signal stops the run and deletes its Job', async () => {
  const ac = new AbortController();
  const s = scripted();
  const k8s = async (m: string, p: string, b?: Record<string, unknown>) => { if (m === 'POST' && p.endsWith('/jobs')) ac.abort(); return m === 'GET' && p.includes('/jobs/') ? { status: 200, body: { status: {} } } : s.k8s(m, p, b); };
  const out = await runGatesSandbox('a', tree(), { ...opts(s), k8s, signal: ac.signal, timeoutMs: 60_000 } as never);
  assert.equal(out.ok ? '' : out.kind, 'superseded');
});
