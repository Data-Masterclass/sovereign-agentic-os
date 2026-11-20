/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       acceptance harness (tests/e2e/kind)
 * FEATURE:    Run a native tool against an ejected domain clone, inside kind, with no OS
 * USER STORY: As AT-f I want "dbt build", "dagster definitions validate", "mf query" and friends to
 *             run in the chart-pinned native image against a plain clone of the domain repo, next to
 *             Trino, with os-ui scaled to zero, exactly as an engineer without the OS would.
 * ARCHITECTURE:
 *   - stripOsLayer(dir) deletes every OS-layer file listed in 11 §4.2 from the clone.
 *   - ejectPod(image) starts a long-running pod (label e2e-eject) with only TRINO_* / OS_PRINCIPAL
 *     in its environment, copies the clone in with `kubectl cp`, and exec()s commands in /work.
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { kubectl, execIn, NS } from '../kube.mjs';
import { HopError } from '../hop.mjs';

const OS_LAYER = [
  (p) => p.startsWith('os/'),
  (p) => /(^|\/)os\.yaml$/.test(p),
  (p) => /(^|\/)system\.yaml$/.test(p),
  (p) => p === 'agents/index.yml',
  (p) => /^apps\/[^/]+\/app\.yaml$/.test(p),
];

async function walk(dir, root = dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full, root))); else out.push(relative(root, full));
  }
  return out;
}

/** Delete the OS layer; returns the deleted relative paths. */
export async function stripOsLayer(dir) {
  const removed = [];
  for (const p of await walk(dir)) {
    if (OS_LAYER.some((f) => f(p))) { await rm(join(dir, p)); removed.push(p); }
  }
  return removed;
}

export async function exists(dir, rel) {
  try { await stat(join(dir, rel)); return true; } catch { return false; }
}

export async function listNative(dir, re) {
  return (await walk(dir)).filter((p) => re.test(p));
}

export async function ejectPod(name, image, { env = {} } = {}) {
  const pod = {
    apiVersion: 'v1', kind: 'Pod',
    metadata: { name, namespace: NS, labels: { 'app.kubernetes.io/part-of': 'e2e-harness', 'e2e-eject': 'true' } },
    spec: {
      restartPolicy: 'Never',
      containers: [{ name: 'tool', image, imagePullPolicy: 'IfNotPresent', command: ['sh', '-c', 'mkdir -p /work && sleep 7200'],
        env: Object.entries(env).map(([k, v]) => ({ name: k, value: String(v) })), workingDir: '/work' }],
    },
  };
  await kubectl(['-n', NS, 'delete', 'pod', name, '--ignore-not-found', '--wait=true']);
  await kubectl(['apply', '-f', '-'], { input: JSON.stringify(pod) });
  await kubectl(['-n', NS, 'wait', '--for=condition=Ready', `pod/${name}`, '--timeout=300s'], { timeoutMs: 320000 });
  return {
    async copy(dir) { await kubectl(['-n', NS, 'cp', `${dir}/.`, `${name}:/work`], { timeoutMs: 300000 }); },
    async run(cmd, hop) {
      try { return await execIn(name, ['sh', '-c', `cd /work && ${cmd}`]); } catch (err) {
        throw new HopError({ component: hop.split(' ')[0], hop, reason: err.reason ?? err.message });
      }
    },
    async remove() { await kubectl(['-n', NS, 'delete', 'pod', name, '--ignore-not-found', '--wait=false']); },
  };
}
