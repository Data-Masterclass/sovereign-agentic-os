/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * Run a container of the RENDERED chart (WP-56): its command, its env, its pod uid and its mount
 * points, with the rendered `backup-scripts` ConfigMap at /opt/soa/backup and a fresh EMPTY host
 * directory as each emptyDir — so a test fails when the chart's container would fail. Only what
 * points outside the test stack is overridden (endpoints, bucket, prefixes, credentials), and the
 * image digest placeholder is swapped for the locally built image of the same Dockerfile.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Under $HOME: bind mounts of it work in Docker Desktop / Colima as well as on a CI runner.
export const RENDER_DIR = process.env.SOA_WP56_RENDER ?? join(homedir(), '.cache', 'soa-wp56-render');
let cache;

export function rendered() {
  if (cache) return cache;
  rmSync(RENDER_DIR, { recursive: true, force: true });
  mkdirSync(RENDER_DIR, { recursive: true });
  const r = spawnSync('python3', [join(ROOT, 'tests', 'backup', 'render.py'), RENDER_DIR], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`render failed (helm + helm dependency build needed): ${r.stderr}`);
  spawnSync('chmod', ['-R', 'a+rX', RENDER_DIR]);
  cache = JSON.parse(readFileSync(join(RENDER_DIR, 'render.json'), 'utf8'));
  return cache;
}

/** A fresh, empty directory standing in for an emptyDir (writable by the pod uid). */
export function emptyDir(path) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Written by the pod uid (999) on a Linux runner: the runner user may not remove it, so the
    // previous run's emptyDir is removed the way the kubelet would — as root, from a container.
    const r = spawnSync('docker', ['run', '--rm', '-v', `${dirname(path)}:/p`, 'alpine:3.21', 'rm', '-rf', `/p/${path.split('/').pop()}`], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`cannot empty ${path}: ${r.stderr}`);
  }
  mkdirSync(path, { recursive: true });
  spawnSync('chmod', ['a+rwx', path]);
  return path;
}

/**
 * Run rendered container `name` (`sidecar` for the git-backup sidecar).
 * opts: { network, image, env (overrides; null deletes), secrets {NAME: value}, dirs {mountPath: hostDir | 'tmpfs'}, volumes [] }
 */
export function runRendered(name, opts) {
  const R = rendered();
  const c = name === 'sidecar' ? R.sidecar : R.drill.containers.find((x) => x.name === name);
  if (!c) throw new Error(`no rendered container ${name}`);
  const env = {};
  for (const [k, v] of Object.entries(c.env)) {
    if (typeof v === 'string') env[k] = v;
    else if (opts.secrets && k in opts.secrets) env[k] = opts.secrets[k];
    else throw new Error(`${name}: secret env ${k} needs a test value`);
  }
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === null) delete env[k];
    else env[k] = v;
  }
  const args = ['run', '--rm', '--network', opts.network, '--user', `${R.drill.uid}:${R.drill.uid}`, '--read-only'];
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  const dirs = opts.dirs ?? {};
  for (const m of c.mounts) {
    if (m === '/opt/soa/backup') args.push('-v', `${join(RENDER_DIR, 'scripts')}:/opt/soa/backup:ro`);
    else if (dirs[m] === 'tmpfs') args.push('--tmpfs', `${m}:rw,mode=1777`); // an emptyDir that must hold sockets
    else if (dirs[m]) args.push('-v', `${dirs[m]}:${m}`);
    else throw new Error(`${name}: mount ${m} needs a host dir`);
  }
  for (const v of opts.volumes ?? []) args.push('-v', v);
  if (!existsSync(join(RENDER_DIR, 'scripts', 'lib.sh'))) throw new Error('rendered scripts missing');
  args.push('--entrypoint', c.command[0], opts.image ?? c.image, ...c.command.slice(1));
  const r = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, log: (r.stdout ?? '') + (r.stderr ?? ''), env };
}
