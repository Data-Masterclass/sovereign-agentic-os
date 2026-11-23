/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       repo tooling / gateway
 * FEATURE:    Talk to a LIVE LiteLLM gateway without its master key ever leaving the pod.
 * ARCHITECTURE:
 *   `inPod()` runs scripts/gateway/gateway_live.py INSIDE the gateway container (`kubectl exec … python3 -c`),
 *   which reads the container's own PROXY_MASTER_KEY and prints allowlisted fields only (never a key). The
 *   environment is chosen like deploy.sh / smoke-test.sh: `--env dev|prod` picks the context (dev:
 *   DEV_KUBE_CONTEXT or dmagosdev; prod: KUBE_CONTEXT or dmagenticos) and runs scripts/lib/env-guard.sh;
 *   `--kubeconfig` / DEV_KUBECONFIG / PROD_KUBECONFIG select the kubeconfig per environment, because the dev
 *   and production kubeconfigs are separate files.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HELPER = resolve(ROOT, 'scripts/gateway/gateway_live.py');

/** The target for one environment: { env, context, kubeconfig, namespace, release }. */
export function target(env, opts = {}) {
  const context = opts.context || (env === 'dev' ? process.env.DEV_KUBE_CONTEXT || 'dmagosdev' : process.env.KUBE_CONTEXT || 'dmagenticos');
  const kubeconfig = opts.kubeconfig || (env === 'dev' ? process.env.DEV_KUBECONFIG : process.env.PROD_KUBECONFIG) || process.env.KUBECONFIG || '';
  return { env, context, kubeconfig, namespace: opts.namespace || process.env.NS || 'agentic-os', release: opts.release || process.env.REL || 'agentic-os' };
}

function kenv(t) {
  return t.kubeconfig ? { ...process.env, KUBECONFIG: t.kubeconfig } : process.env;
}

/** Refuse a context that is not the environment it claims to be (scripts/lib/env-guard.sh). */
export function guard(t) {
  if (process.env.GATEWAY_SKIP_ENV_GUARD === '1') return;
  try {
    execFileSync('bash', [resolve(ROOT, 'scripts/lib/env-guard.sh'), '--env', t.env, '--context', t.context], { env: kenv(t), stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const msg = String(e.stdout || '') + String(e.stderr || '');
    throw new Error(`env guard refused ${t.env} context ${t.context}: ${msg.trim().split('\n').pop()}`);
  }
}

/** Run gateway_live.py <args> in the gateway pod; returns its JSON. Throws { unreachable: true } when kubectl cannot reach it. */
export function inPod(t, args) {
  const kubectl = process.env.KUBECTL || 'kubectl';
  let out;
  try {
    out = execFileSync(kubectl, ['--context', t.context, '-n', t.namespace, 'exec', `deploy/${t.release}-litellm`, '-c', 'litellm', '--', 'python3', '-c', readFileSync(HELPER, 'utf8'), ...args],
      { env: kenv(t), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
  } catch (e) {
    const err = new Error(`${t.env} (${t.context}): the gateway could not be read — ${String(e.stderr || e.message).trim().split('\n').pop()}`);
    err.unreachable = true;
    throw err;
  }
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`${t.env} (${t.context}): unexpected answer from the gateway helper (${out.slice(0, 200)})`);
  }
}

/** Read the live config-file model_list from the gateway ConfigMap (env references only, never a key value). */
export function configModels(t, yaml) {
  const kubectl = process.env.KUBECTL || 'kubectl';
  const text = execFileSync(kubectl, ['--context', t.context, '-n', t.namespace, 'get', 'configmap', `${t.release}-litellm-config`, '-o', 'jsonpath={.data.config\\.yaml}'],
    { env: kenv(t), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return (yaml.load(text) ?? {}).model_list ?? [];
}

export function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { o[k] = next; i++; } else o[k] = true;
    } else o._.push(a);
  }
  return o;
}
