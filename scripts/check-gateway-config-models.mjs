#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Chart/deploy guard — dev and production render NO config-file gateway models.
 * USER STORY: As the owner I create every model by hand in each environment's LiteLLM (database managed,
 *             separate provider keys per environment). Nothing in git may put a model into the dev or
 *             production gateway's config file again — not the chart's laptop seed, not a stale list in the
 *             live production values, not a copy in dev's private overlay.
 * ARCHITECTURE:
 *   scripts/deploy.sh layers deploy/gateway-no-config-models.yaml (`model_list: []`) LAST on both environments.
 *   This check proves, with pure file reads plus `helm template`:
 *     1. deploy.sh adds that file AFTER every VALUES_OVERLAY and outside the prod-only branch, and the only
 *        values file it adds after it is the generated API-server overlay, which sets nothing but
 *        `networkPolicies` (scripts/lib/apiserver-cidrs.py);
 *     2. the file sets ONLY `litellm.proxy_config.model_list`, and that list is empty (layered last, any other
 *        value in it would replace an operator's value on every deploy);
 *     3. no committed dev values file (values.dev*.yaml) sets `litellm.proxy_config.model_list`;
 *     4. merged as Helm merges (maps deep-merge, lists replace) — dev with a private overlay that carries a
 *        STALE list, production with a live release that carries a STALE list, as both really did on
 *        2026-11-23 — both end with no config model;
 *     5. RENDERED with `helm template` the same way, both LiteLLM ConfigMaps hold no model. Needs helm and the
 *        subchart .tgz files: without them it SKIPS loudly; in CI (`process.env.CI`) a skip FAILS.
 *   `PARITY_TWIN=dev-list|list-not-empty|catalog-not-last|overlay-after-catalog|operator-key|late-model` plants
 *   one fault so scripts/tests/gateway-config-models.test.sh can prove each rule fails.
 *   The LIVE side (dev vs prod catalogs in LiteLLM's databases) is scripts/check-gateway-parity-live.mjs.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'check-gateway-config-models';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(ROOT, 'os-ui/package.json'));
const yaml = require('js-yaml');
const FILE = 'deploy/gateway-no-config-models.yaml';
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

const twin = process.env.PARITY_TWIN ?? '';
let file = loadYaml(FILE);
if (twin === 'list-not-empty') file = merge(file, { litellm: { proxy_config: { model_list: [{ model_name: 'from-git' }] } } });
if (twin === 'operator-key') file = merge(file, { llmProviders: { allowHosts: ['api.lyceum.technology'] } });
const problems = [];

// 1. deploy.sh ordering.
{
  let lines = read('scripts/deploy.sh').split('\n');
  if (twin === 'catalog-not-last') lines = [...lines, 'OVERLAY_ARGS+=(-f "$VALUES_OVERLAY")'];
  if (twin === 'overlay-after-catalog') lines = [...lines, 'OVERLAY_ARGS+=(-f "$WORK/extra.yaml")'];
  if (!lines.some((l) => /^GATEWAY_CONFIG_MODELS=deploy\/gateway-no-config-models\.yaml\b/.test(l))) problems.push(`scripts/deploy.sh does not set GATEWAY_CONFIG_MODELS=${FILE}`);
  const at = lines.findIndex((l) => /^\s*OVERLAY_ARGS\+=\(-f "\$GATEWAY_CONFIG_MODELS"\)/.test(l));
  if (at < 0) problems.push('scripts/deploy.sh never adds -f "$GATEWAY_CONFIG_MODELS" to OVERLAY_ARGS');
  lines.forEach((l, i) => {
    if (at < 0 || i <= at || !/OVERLAY_ARGS\+?=\(/.test(l)) return;
    if (/VALUES_OVERLAY/.test(l)) problems.push(`scripts/deploy.sh:${i + 1} layers VALUES_OVERLAY AFTER ${FILE} — an overlay could bring config models back on one environment`);
    else if (!/OVERLAY_ARGS\+=\(-f "\$APISERVER_OVERLAY"\)/.test(l)) problems.push(`scripts/deploy.sh:${i + 1} adds a values file AFTER ${FILE} (${l.trim()}); only the generated API-server overlay may follow it`);
  });
  const printed = [...read('scripts/lib/apiserver-cidrs.py').matchAll(/print\("([A-Za-z]+):\\n/g)].map((m) => m[1]);
  if (printed.length !== 1 || printed[0] !== 'networkPolicies') problems.push(`scripts/lib/apiserver-cidrs.py (its overlay is layered after ${FILE}) must print a networkPolicies-only overlay; found top-level keys ${JSON.stringify(printed)}`);
  const fi = lines.findIndex((l) => /^fi\s+# end of the prod values derivation/.test(l));
  if (at >= 0 && fi >= 0 && at < fi) problems.push(`scripts/deploy.sh adds ${FILE} inside the prod-only branch; it must be layered on BOTH environments`);
}

// 2. The file sets only an empty model_list.
{
  const walk = (v, path) => {
    if (path === 'litellm.proxy_config.model_list') {
      if (!Array.isArray(v) || v.length) problems.push(`${FILE}: litellm.proxy_config.model_list must be an empty list (models live in each environment's LiteLLM database)`);
      return;
    }
    if (isMap(v) && Object.keys(v).length) { for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k); return; }
    problems.push(`${FILE} sets ${path} — layered last, it would REPLACE the operator's value on every deploy`);
  };
  walk(file, '');
  if (!Array.isArray(file?.litellm?.proxy_config?.model_list)) problems.push(`${FILE} does not set litellm.proxy_config.model_list`);
}

// 3. No dev values file carries its own model list.
const devFiles = readdirSync(ROOT).filter((f) => /^values\.dev.*\.yaml$/.test(f)).sort();
const devValues = Object.fromEntries(devFiles.map((f) => [f, loadYaml(f)]));
if (twin === 'dev-list') devValues['values.dev.yaml'] = merge(devValues['values.dev.yaml'], { litellm: { proxy_config: { model_list: [{ model_name: 'dev-only' }] } } });
for (const [f, v] of Object.entries(devValues)) {
  if (v?.litellm?.proxy_config?.model_list !== undefined) problems.push(`${f} sets litellm.proxy_config.model_list — dev's models are LiteLLM database rows, created by hand`);
}

// 4. Helm-style merge of both environments.
const base = loadYaml(`${CHART}/values.yaml`);
const STALE_DEV = { litellm: { proxy_config: { model_list: [{ model_name: 'stale-dev-private-only' }] } } };
const STALE_PROD = { litellm: { proxy_config: { model_list: [{ model_name: 'sovereign-default' }] } } };
const late = twin === 'late-model' ? { litellm: { proxy_config: { model_list: [{ model_name: 'came-after' }] } } } : {};
const merged = { dev: merge(merge(merge(merge(base, devValues['values.dev.yaml'] ?? {}), STALE_DEV), file), late) };
for (const f of devFiles.filter((x) => x !== 'values.dev.yaml')) merged[`dev + ${f}`] = merge(merge(merge(merge(base, devValues['values.dev.yaml'] ?? {}), devValues[f]), STALE_DEV), file);
merged.prod = merge(merge(base, STALE_PROD), file);
for (const [env, v] of Object.entries(merged)) if (names(v).length) problems.push(`merged values (${env}): config models [${names(v).join(', ')}] — dev and prod must carry none`);

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
  const dir = mkdtempSync(join(tmpdir(), 'gateway-config-models-'));
  const f = (n, v) => { const p = join(dir, n); writeFileSync(p, yaml.dump(v)); return p; };
  const render = (files) => {
    const out = execFileSync('helm', ['template', 'agentic-os', resolve(ROOT, CHART), '-n', 'agentic-os', ...files.flatMap((x) => ['-f', x]), '--set', 'global.allowChartDefaultSecrets=true', '--skip-schema-validation'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const d of yaml.loadAll(out)) if (d?.kind === 'ConfigMap' && /-litellm-config$/.test(d.metadata?.name ?? '')) return (yaml.load(d.data['config.yaml'])?.model_list ?? []).map((m) => m?.model_name);
    throw new Error('no *-litellm-config ConfigMap in the render');
  };
  try {
    const fileP = f('file.yaml', file);
    const dev = render([resolve(ROOT, 'values.dev.yaml'), f('stale-dev.yaml', STALE_DEV), fileP, f('late.yaml', late)]);
    const prod = render([f('stale-prod.yaml', STALE_PROD), fileP]);
    if (dev.length) problems.push(`helm render (dev): the LiteLLM ConfigMap holds config models [${dev.join(', ')}]`);
    if (prod.length) problems.push(`helm render (prod): the LiteLLM ConfigMap holds config models [${prod.join(', ')}]`);
    rendered = 'both rendered ConfigMaps hold no model';
  } catch (e) {
    problems.push(`helm render failed — ${String(e.stderr || e.message).trim().split('\n').pop()}`);
  }
}

if (problems.length) {
  console.error(`${NAME}: FAIL`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`${NAME}: ok — dev and prod render no config-file gateway models; ${FILE} is layered last (render: ${rendered})`);
