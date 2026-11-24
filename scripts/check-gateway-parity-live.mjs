#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Live parity check — dev's and production's gateway model catalogs are the same.
 * USER STORY: As the owner I create every model by hand in each environment's LiteLLM (database managed;
 *             separate provider keys per environment by design). Parity is CHECKED, not enforced: this
 *             compares the two live catalogs and names every difference, so a model tested on dev is
 *             created identically on production — and the production release stops when they differ.
 * USAGE:
 *   node scripts/check-gateway-parity-live.mjs [--dev-context <ctx>] [--prod-context <ctx>]
 *        [--dev-kubeconfig <file>] [--prod-kubeconfig <file>]     (or DEV_KUBECONFIG / PROD_KUBECONFIG)
 *   node scripts/check-gateway-parity-live.mjs --dev-json <file> --prod-json <file>   (offline, for tests)
 *   Exit 0 = same; 1 = differences (listed); 2 = an environment could not be read (named).
 * ARCHITECTURE:
 *   Each catalog is read INSIDE that environment's gateway pod by scripts/gateway/gateway_live.py `catalog`
 *   (read-only; the master key stays in the pod; allowlisted fields only — never a key, never an id).
 *   Compared per model name (role aliases separately): the deployments' provider model (`<provider>/<model>`),
 *   api_base, the routing parameters (timeout, reasoning_effort, extra_body, …), and model_info: mode, limits
 *   (max_input/max_output tokens, output_vector_size), prices (input/output/cache-read per token) and every
 *   supports_* flag. IGNORED: keys, credentials, ids, and whether a row is config or database managed.
 *   deploy/gateway-parity.yaml lists api_base addresses that count as equal (dev reaches STACKIT through
 *   model-key-proxy). The role mapping (model_group_alias) is compared too.
 *   Used by: scripts/release.sh (gate for --env prod), scripts/smoke-test.sh (prints the diff), by hand.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { ROOT, args, guard, inPod, target } from './gateway/lib.mjs';

const require = createRequire(resolve(ROOT, 'os-ui/package.json'));
const yaml = require('js-yaml');
const a = args(process.argv.slice(2));

const cfg = yaml.load(readFileSync(resolve(ROOT, 'deploy/gateway-parity.yaml'), 'utf8')) ?? {};
const canonBase = new Map();
for (const group of cfg.apiBaseEquivalents ?? []) for (const b of group) canonBase.set(String(b).replace(/\/+$/, ''), String(group[0]).replace(/\/+$/, ''));
const base = (b) => { const s = String(b ?? '').replace(/\/+$/, ''); return canonBase.get(s) ?? s; };

function read(env) {
  if (a[`${env}-json`]) return JSON.parse(readFileSync(a[`${env}-json`], 'utf8'));
  const t = target(env, { context: a[`${env}-context`], kubeconfig: a[`${env}-kubeconfig`] });
  guard(t);
  return inPod(t, ['catalog']);
}

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const canon = (v) => JSON.stringify(v, (_, x) => (isMap(x) ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => (p < q ? -1 : 1))) : x));
/** One deployment as compared: no db flag, api_base canonical, numbers as numbers. */
function norm(d) {
  const params = { ...(d.params ?? {}) };
  if ('api_base' in params) params.api_base = base(params.api_base);
  const info = { ...(d.info ?? {}) };
  delete info.access_groups; // who may call it is per environment (keys differ by design)
  return canon({ params, info });
}
function fields(x, y) {
  const px = JSON.parse(x), py = JSON.parse(y), out = [];
  for (const part of ['params', 'info']) {
    for (const k of new Set([...Object.keys(px[part]), ...Object.keys(py[part])])) {
      if (canon(px[part][k]) !== canon(py[part][k])) out.push(`${part === 'info' ? 'model_info.' : ''}${k}: dev ${JSON.stringify(px[part][k])} ≠ prod ${JSON.stringify(py[part][k])}`);
    }
  }
  return out;
}

let dev, prod;
try {
  dev = read('dev');
  prod = read('prod');
} catch (e) {
  console.error(`GATEWAY_PARITY_UNREADABLE — ${e.message}`);
  process.exit(2);
}

const diffs = [];
const names = [...new Set([...Object.keys(dev.models ?? {}), ...Object.keys(prod.models ?? {})])].sort();
for (const n of names) {
  const d = (dev.models?.[n] ?? []).map(norm).sort();
  const p = (prod.models?.[n] ?? []).map(norm).sort();
  if (!d.length) { diffs.push(`${n}: only on prod`); continue; }
  if (!p.length) { diffs.push(`${n}: only on dev`); continue; }
  const ud = [...new Set(d)], up = [...new Set(p)];
  if (canon(ud) === canon(up)) continue;
  if (ud.length === 1 && up.length === 1) diffs.push(`${n}: ${fields(ud[0], up[0]).join('; ')}`);
  else diffs.push(`${n}: the deployments differ (dev ${ud.length} distinct, prod ${up.length} distinct) — compare them in each LiteLLM UI`);
}
for (const [env, c] of [['dev', dev], ['prod', prod]]) {
  for (const al of c.alias_conflicts ?? []) diffs.push(`${env}: a model row is named like the role alias ${al} but is not that alias — rename or delete the row (a name must be either a model or an alias)`);
}
for (const al of [...new Set([...Object.keys(dev.aliases ?? {}), ...Object.keys(prod.aliases ?? {})])].sort()) {
  const x = dev.aliases?.[al], y = prod.aliases?.[al];
  if (x !== y) diffs.push(`role alias ${al}: dev → ${x ?? '(none)'}, prod → ${y ?? '(none)'}`);
}

if (a.json) console.log(JSON.stringify({ same: !diffs.length, models: names.length, differences: diffs }));
if (!diffs.length) {
  if (!a.json) console.log(`GATEWAY_PARITY_OK — dev and prod serve the same ${names.length} models with the same parameters, limits and prices (aliases: ${Object.keys(dev.aliases ?? {}).length})`);
  process.exit(0);
}
if (!a.json) {
  console.log(`GATEWAY_PARITY_DIFFERS — ${diffs.length} difference(s) between the dev and prod gateway catalogs:`);
  for (const d of diffs) console.log(`  - ${d}`);
  console.log('  Create or fix the model by hand in the LiteLLM UI of the environment that is behind (docs/components/litellm.md "Owner runbook").');
}
process.exit(1);
