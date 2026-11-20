/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       acceptance harness (tests/e2e/kind)
 * FEATURE:    kubectl access to the kind cluster: port-forwards, logs, objects, exec
 * USER STORY: As a journey I want to reach each component's own API and read its own logs from
 *             the host, exactly as an operator would, without any OS code in between.
 * ARCHITECTURE:
 *   - Shells out to kubectl with --context kind-$E2E_CLUSTER (never the current context, so the
 *     harness can never touch a real cluster by accident).
 *   - portForward() starts `kubectl port-forward svc/<name> :<port>` (or any `<kind>/<name>` target,
 *     e.g. deployment/trino to reach a sidecar bound to the pod's 127.0.0.1), parses the local port, and
 *     keeps one forward per service:port for the life of the process.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { HopError } from './hop.mjs';

const exec = promisify(execFile);
export const CLUSTER = process.env.E2E_CLUSTER ?? 'wp02';
export const NS = process.env.E2E_NAMESPACE ?? 'agentic-os';
const CONTEXT = `kind-${CLUSTER}`;

export async function kubectl(args, { input, timeoutMs = 120000 } = {}) {
  try {
    const p = exec('kubectl', ['--context', CONTEXT, ...args], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
    if (input !== undefined) p.child.stdin.end(input);
    const { stdout } = await p;
    return stdout;
  } catch (err) {
    throw new HopError({ component: 'kubernetes', hop: `kubectl ${args.slice(0, 3).join(' ')}`, reason: (err.stderr || err.message).trim().slice(0, 400) });
  }
}

export async function getJson(kind, name, ns = NS) {
  return JSON.parse(await kubectl(['-n', ns, 'get', kind, ...(name ? [name] : []), '-o', 'json']));
}

/** Logs of every pod matching a label selector, all containers, since `since` (e.g. "30m"). */
export async function logs(selector, { container, since = '2h', ns = NS } = {}) {
  const args = ['-n', ns, 'logs', '-l', selector, '--tail=-1', `--since=${since}`, '--prefix', '--max-log-requests=20'];
  if (container) args.push('-c', container); else args.push('--all-containers');
  return kubectl(args);
}

export async function execIn(target, cmd, { container, ns = NS, input } = {}) {
  const args = ['-n', ns, 'exec', ...(input !== undefined ? ['-i'] : []), target];
  if (container) args.push('-c', container);
  return kubectl([...args, '--', ...cmd], { input });
}

const forwards = new Map();
export function portForward(service, port, ns = NS) {
  const key = `${ns}/${service}:${port}`;
  if (forwards.has(key)) return forwards.get(key);
  const p = new Promise((resolve, reject) => {
    const child = spawn('kubectl', ['--context', CONTEXT, '-n', ns, 'port-forward', service.includes('/') ? service : `svc/${service}`, `:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.unref();
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new HopError({ component: service, hop: 'port-forward', reason: `no forward after 30s ${err.trim()}` })); }, 30000);
    child.stdout.on('data', (b) => {
      const m = /127\.0\.0\.1:(\d+)/.exec(String(b));
      if (m) { clearTimeout(timer); resolve({ url: `http://127.0.0.1:${m[1]}`, port: Number(m[1]), child }); }
    });
    child.stderr.on('data', (b) => { err += String(b); });
    child.on('exit', (code) => { clearTimeout(timer); forwards.delete(key); reject(new HopError({ component: service, hop: 'port-forward', reason: `kubectl exited ${code}: ${err.trim().slice(0, 300)}` })); });
  });
  p.catch(() => forwards.delete(key));
  forwards.set(key, p);
  return p;
}

export function closeForwards() {
  for (const p of forwards.values()) p.then((f) => f.child.kill(), () => {});
  forwards.clear();
}
