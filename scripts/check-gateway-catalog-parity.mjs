#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Release/CI guard — dev and production render the SAME gateway model catalog.
 * USER STORY: As the owner I want dev and production to be identical: every model reaches dev first and
 *             production with the next release, from git, never from a hand edit in the LiteLLM UI or a
 *             private overlay. On 2026-11-23 production listed 7 model names and dev 10 (dev's private
 *             overlay carried its own list); this check makes that a red build.
 * ARCHITECTURE:
 *   The catalog is ONE file, deploy/gateway-models.yaml, which scripts/deploy.sh layers LAST on both
 *   environments (Helm replaces a list whole, so no earlier list survives). This check proves it:
 *     1. deploy.sh adds the catalog to its values AFTER every VALUES_OVERLAY, on both env paths;
 *     2. no committed dev values file (values.dev*.yaml) sets `litellm.proxy_config.model_list`
 *        (it would be dead, and it is how the two copies drifted);
 *     3. the catalog's model names are unique, and every COMPATIBILITY ALIAS (the old names,
 *        `DEPRECATED_ALIASES` in os-ui/core/models/role-names.ts) is an exact copy — litellm_params AND
 *        model_info — of the catalog model its role is seeded to (`osUI.modelRoles.seed` in the file);
 *     4. merged as Helm merges (maps deep-merge, lists replace), dev (chart + values.dev.yaml + each dev
 *        node/model overlay + a private overlay that carries a STALE list, like the real one did) and prod
 *        (chart + a live release that carries a STALE list, like production's) end with the same
 *        model_name set, equal to the catalog's;
 *     5. RENDERED with `helm template` the same way, the two LiteLLM ConfigMaps hold the same model_name
 *        set. Needs helm and the subchart .tgz files: without them it SKIPS loudly, and in CI
 *        (`process.env.CI`) a skip is a FAILURE.
 *   `--names` prints the catalog's model names, sorted, one per line (scripts/smoke-test.sh compares the
 *   live ConfigMap with them). `PARITY_TWIN=dev-list|alias-drift|catalog-not-last|env-only-model` plants
 *   one fault so scripts/tests/gateway-catalog-parity.test.sh can prove each rule fails.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'check-gateway-catalog-parity';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(ROOT, 'os-ui/package.json'));
const yaml = require('js-yaml');
const CATALOG = 'deploy/gateway-models.yaml';
const CHART = 'charts/sovereign-agentic-os';

const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
const loadYaml = (p) => yaml.load(read(p)) ?? {};
const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function merge(base, overlay) {
  if (!isMap(base) || !isMap(overlay)) return overlay === undefined || overlay === null ? base : overlay;
  const out = { ...base };
  for (const [k, v] of Object.entries(overlay)) out[k] = merge(base[k], v);
  return out;
}
const names = (v) => (v?.litellm?.proxy_config?.model_list ?? []).map((m) => m?.model_name);
const sorted = (a) => [...a].sort();
const sameSet = (a, b) => JSON.stringify(sorted(new Set(a))) === JSON.stringify(sorted(new Set(b)));
const canon = (v) => JSON.stringify(v, (_, x) => (isMap(x) ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => (p < q ? -1 : 1))) : x));

const twin = process.env.PARITY_TWIN ?? '';
let catalog = loadYaml(CATALOG);
if (twin === 'alias-drift') {
  catalog = structuredClone(catalog);
  const e = catalog.litellm.proxy_config.model_list.find((m) => m.model_name === 'sovereign-reasoning');
  e.litellm_params = { ...e.litellm_params, timeout: 30 };
}

if (process.argv.includes('--names')) {
  for (const n of sorted(names(catalog))) console.log(n);
  process.exit(0);
}

const problems = [];

// 1. deploy.sh layers the catalog after every VALUES_OVERLAY.
{
  let lines = read('scripts/deploy.sh').split('\n');
  if (twin === 'catalog-not-last') lines = [...lines, 'OVERLAY_ARGS+=(-f "$VALUES_OVERLAY")'];
  const at = lines.findIndex((l) => /^\s*OVERLAY_ARGS\+=\(-f "\$GATEWAY_CATALOG"\)/.test(l));
  if (!lines.some((l) => /^GATEWAY_CATALOG=deploy\/gateway-models\.yaml\b/.test(l))) problems.push(`scripts/deploy.sh does not set GATEWAY_CATALOG=${CATALOG}`);
  if (at < 0) problems.push('scripts/deploy.sh never adds -f "$GATEWAY_CATALOG" to OVERLAY_ARGS');
  lines.forEach((l, i) => {
    if (/OVERLAY_ARGS\+?=\(.*VALUES_OVERLAY/.test(l) && i > at) problems.push(`scripts/deploy.sh:${i + 1} layers VALUES_OVERLAY AFTER the gateway catalog — an overlay could then replace the model list on one environment`);
  });
  const fi = lines.findIndex((l) => /^fi\s+# end of the prod values derivation/.test(l));
  if (at >= 0 && fi >= 0 && at < fi) problems.push('scripts/deploy.sh adds the gateway catalog inside the prod-only branch; it must be layered on BOTH environments');
}

// 2. No dev values file carries its own model list.
const devFiles = readdirSync(ROOT).filter((f) => /^values\.dev.*\.yaml$/.test(f)).sort();
const devValues = Object.fromEntries(devFiles.map((f) => [f, loadYaml(f)]));
if (twin === 'dev-list') devValues['values.dev.yaml'] = merge(devValues['values.dev.yaml'], { litellm: { proxy_config: { model_list: [{ model_name: 'dev-only' }] } } });
for (const [f, v] of Object.entries(devValues)) {
  if (v?.litellm?.proxy_config?.model_list !== undefined) problems.push(`${f} sets litellm.proxy_config.model_list — the catalog for dev and prod is ${CATALOG} only`);
}

// 3. Unique names; compatibility aliases are exact copies of their role's catalog model.
const list = catalog.litellm?.proxy_config?.model_list ?? [];
const catalogNames = names(catalog);
if (!list.length) problems.push(`${CATALOG} has no litellm.proxy_config.model_list`);
for (const n of new Set(catalogNames)) if (catalogNames.filter((x) => x === n).length > 1) problems.push(`${CATALOG}: model_name ${n} appears twice (LiteLLM would load-balance across both entries)`);
{
  const src = read('os-ui/core/models/role-names.ts');
  const block = src.slice(src.indexOf('DEPRECATED_ALIASES'));
  const aliases = [...block.slice(0, block.indexOf('};')).matchAll(/'([^']+)':\s*'(sovereign-[a-z]+)'/g)].map((m) => [m[1], m[2]]);
  if (!aliases.length) problems.push('could not read DEPRECATED_ALIASES from os-ui/core/models/role-names.ts');
  const seed = catalog.osUI?.modelRoles?.seed ?? {};
  const byName = new Map(list.map((m) => [m.model_name, m]));
  for (const [old, role] of aliases) {
    const entry = byName.get(old);
    if (!entry) continue; // after the removal release the old names are simply gone
    const target = byName.get(seed[role]);
    if (!target) { problems.push(`${old}: its role ${role} is seeded to ${seed[role] ?? '(nothing)'}, which is not in ${CATALOG}`); continue; }
    for (const part of ['litellm_params', 'model_info']) {
      if (canon(entry[part]) !== canon(target[part])) problems.push(`compatibility alias ${old}: ${part} differs from ${target.model_name} (the model its role ${role} uses) — an alias must be an exact copy`);
    }
  }
}

// 4. Helm-style merge of both environments.
const base = loadYaml(`${CHART}/values.yaml`);
const STALE_DEV = { litellm: { proxy_config: { model_list: [{ model_name: 'stale-dev-private-only' }] } } };
const STALE_PROD = { litellm: { proxy_config: { model_list: [{ model_name: 'sovereign-default' }, { model_name: 'stale-prod-release-only' }] } } };
const late = twin === 'env-only-model' ? { litellm: { proxy_config: { model_list: [...list, { model_name: 'dev-hand-added' }] } } } : {};
const merged = {};
merged['dev'] = merge(merge(merge(merge(base, devValues['values.dev.yaml'] ?? {}), STALE_DEV), catalog), late);
for (const f of devFiles.filter((x) => x !== 'values.dev.yaml')) merged[`dev + ${f}`] = merge(merge(merge(merge(base, devValues['values.dev.yaml'] ?? {}), devValues[f]), STALE_DEV), catalog);
merged['prod'] = merge(merge(base, STALE_PROD), catalog);
for (const [env, v] of Object.entries(merged)) {
  if (!sameSet(names(v), catalogNames)) problems.push(`merged values (${env}): model names [${sorted(names(v)).join(', ')}] ≠ the catalog [${sorted(catalogNames).join(', ')}]`);
}

// 5. Rendered by helm.
let rendered = 'skipped';
function skip(reason) {
  if (process.env.CI) problems.push(`helm render: ${reason} — a chart check may not silently skip in CI`);
  else console.error(`${NAME}: SKIP helm render — ${reason}`);
}
let helmOk = true;
try { execFileSync('helm', ['version', '--short'], { stdio: 'ignore' }); } catch { helmOk = false; skip('helm not on PATH'); }
const depsOk = helmOk && existsSync(resolve(ROOT, CHART, 'charts')) && readdirSync(resolve(ROOT, CHART, 'charts')).some((f) => f.endsWith('.tgz'));
if (helmOk && !depsOk) skip(`no subchart .tgz in ${CHART}/charts (run \`helm dependency build ${CHART}\`)`);
if (depsOk) {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-parity-'));
  const file = (n, v) => { const p = join(dir, n); writeFileSync(p, yaml.dump(v)); return p; };
  const cat = file('catalog.yaml', catalog);
  const lateF = file('late.yaml', late);
  const render = (files) => {
    const out = execFileSync('helm', ['template', 'agentic-os', resolve(ROOT, CHART), '-n', 'agentic-os', ...files.flatMap((f) => ['-f', f]), '--set', 'global.allowChartDefaultSecrets=true', '--skip-schema-validation'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const d of yaml.loadAll(out)) {
      if (d?.kind === 'ConfigMap' && /-litellm-config$/.test(d.metadata?.name ?? '')) return (yaml.load(d.data['config.yaml'])?.model_list ?? []).map((m) => m?.model_name);
    }
    throw new Error('no *-litellm-config ConfigMap in the render');
  };
  try {
    const dev = render([resolve(ROOT, 'values.dev.yaml'), file('stale-dev.yaml', STALE_DEV), cat, lateF]);
    const prod = render([file('stale-prod.yaml', STALE_PROD), cat]);
    if (!sameSet(dev, prod)) problems.push(`helm render: dev ConfigMap models [${sorted(dev).join(', ')}] ≠ prod ConfigMap models [${sorted(prod).join(', ')}]`);
    else if (!sameSet(dev, catalogNames)) problems.push(`helm render: the ConfigMaps hold [${sorted(dev).join(', ')}], not the catalog [${sorted(catalogNames).join(', ')}]`);
    rendered = `${dev.length} models in both rendered ConfigMaps`;
  } catch (e) {
    problems.push(`helm render failed — ${String(e.stderr || e.message).trim().split('\n').pop()}`);
  }
}

if (problems.length) {
  console.error(`${NAME}: FAIL`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`${NAME}: ok — dev and prod carry the same ${catalogNames.length} gateway models from ${CATALOG} (render: ${rendered})`);
