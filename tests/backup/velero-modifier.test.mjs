/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * WP-56 — the Velero drill's resource modifier, applied the way Velero v1.15 applies it
 * (pkg/restore/restore.go): the pod-volume RestoreItemAction FIRST prepends its `restore-wait`
 * init container (mounting every fs-restored volume), THEN the resource modifier's strategic
 * merge patch runs. The patch is applied with kubectl's own strategic merge (`kubectl patch
 * --local --type strategic`), on the os-ui pod the chart renders.
 *
 * Proves: restore-wait survives and is the only init container; the only app container is the
 * checker; every volume any container mounts exists; no ConfigMap/Secret volume is left (the
 * scratch namespace has none). Negative twin: a patch that replaces the init containers (the
 * first version of this drill) removes restore-wait and the same predicate rejects it.
 * Not a real Velero run: the live version (v1.15.0) was read; the order is from its source.
 *
 * Run: python3 tests/backup/render.py needs helm + `helm dependency build`; then node --test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = mkdtempSync(join(tmpdir(), 'wp56-velero-'));
const r = spawnSync('python3', [join(ROOT, 'tests', 'backup', 'render.py'), dir], { cwd: ROOT, encoding: 'utf8' });
if (r.status !== 0) throw new Error(`render failed: ${r.stderr}`);
const { osuiPod, modifier } = JSON.parse(readFileSync(join(dir, 'render.json'), 'utf8'));

/** The pod as Velero hands it to the modifier: restore-wait prepended, mounting fs-backed volumes. */
function asVeleroRestores(spec) {
  const fsVolumes = spec.volumes.filter((v) => v.persistentVolumeClaim || v.emptyDir).map((v) => v.name);
  const restoreWait = {
    name: 'restore-wait',
    image: 'velero/velero:v1.15.0',
    command: ['/velero-restore-helper'],
    volumeMounts: fsVolumes.map((n) => ({ name: n, mountPath: `/restores/${n}` })),
  };
  return { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'os-ui-x', namespace: 'agentic-os' },
    spec: { ...spec, initContainers: [restoreWait, ...(spec.initContainers ?? [])] } };
}

function applyStrategic(pod, patch) {
  const f = join(dir, `pod-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, JSON.stringify(pod));
  const k = spawnSync('kubectl', ['patch', '-f', f, '--local', '--type', 'strategic', '-p', JSON.stringify(patch), '-o', 'json'], { encoding: 'utf8' });
  assert.equal(k.status, 0, k.stderr);
  return JSON.parse(k.stdout).spec;
}

function problems(spec) {
  const p = [];
  const init = (spec.initContainers ?? []).map((c) => c.name);
  if (init[0] !== 'restore-wait') p.push(`restore-wait is not the first init container: [${init}]`);
  if (init.length !== 1) p.push(`init containers other than restore-wait remain: [${init}]`);
  const names = spec.containers.map((c) => c.name);
  if (names.join() !== 'velero-drill-check') p.push(`containers are [${names}]`);
  const vols = new Set(spec.volumes.map((v) => v.name));
  for (const c of [...(spec.initContainers ?? []), ...spec.containers]) {
    for (const m of c.volumeMounts ?? []) if (!vols.has(m.name)) p.push(`${c.name} mounts missing volume ${m.name}`);
    for (const e of c.env ?? []) if (e.valueFrom) p.push(`${c.name} env ${e.name} needs a Secret/ConfigMap`);
  }
  for (const v of spec.volumes) if (v.configMap || v.secret || v.projected) p.push(`volume ${v.name} needs an object the scratch namespace lacks`);
  if (spec.restartPolicy !== 'Never') p.push('restartPolicy is not Never');
  const check = spec.containers.find((c) => c.name === 'velero-drill-check');
  if (!check?.volumeMounts?.some((m) => m.name === 'os-repos' && m.readOnly)) p.push('the checker does not mount os-repos read-only');
  return p;
}

test('the modifier keeps restore-wait, drops what the scratch namespace lacks, runs only the checker', () => {
  const spec = applyStrategic(asVeleroRestores(osuiPod), modifier);
  assert.deepEqual(problems(spec), []);
  // restore-wait still mounts the volume the node-agent fills
  assert.ok(spec.initContainers[0].volumeMounts.some((m) => m.name === 'os-repos'));
});

test('the drop lists match the rendered os-ui pod exactly (no drift when the pod changes)', () => {
  const initNames = (osuiPod.initContainers ?? []).map((c) => c.name).sort();
  const dropInit = modifier.spec.initContainers.map((c) => c.name).sort();
  assert.deepEqual(dropInit, initNames, 'every os-ui init container is dropped, by name');
  const objVols = osuiPod.volumes.filter((v) => v.configMap || v.secret || v.projected).map((v) => v.name).sort();
  const dropVols = modifier.spec.volumes.filter((v) => v.$patch === 'delete').map((v) => v.name).sort();
  assert.deepEqual(dropVols, objVols, 'every ConfigMap/Secret volume of os-ui is dropped, by name');
});

test('NEGATIVE TWIN: replacing the init containers (the first version) removes restore-wait and is rejected', () => {
  const bad = { spec: { ...modifier.spec, initContainers: [{ $patch: 'replace' }] } };
  const spec = applyStrategic(asVeleroRestores(osuiPod), bad);
  assert.ok(problems(spec).some((x) => x.includes('restore-wait')), JSON.stringify(problems(spec)));
});
