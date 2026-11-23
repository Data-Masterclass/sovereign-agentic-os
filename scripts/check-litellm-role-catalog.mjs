#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Chart test — the catalog is seeded under REAL model names, the first role mapping is a chart value
 *             that points into that catalog, and the scoped agent key allows the three role names.
 * USER STORY: As the owner I want the OS to call sovereign-strong / -worker / -embedding only, and every other
 *             name in the gateway to be a real model the platform team can see, swap and remove in LiteLLM.
 * ARCHITECTURE:
 *   For the base chart, the STACKIT profile, and dev and prod (each with deploy/gateway-models.yaml, the one
 *   catalog deploy.sh layers last on both; layered the way Helm merges values):
 *     1. `litellm.proxy_config.model_list` has no role name, and no OLD alias (sovereign-default/-mock/-reasoning/
 *        -reasoning-fast/-premium/-vision/-embed) — EXCEPT the compatibility aliases in deploy/gateway-models.yaml,
 *        kept for ONE release (exact copies of their role's model: scripts/check-gateway-catalog-parity.mjs;
 *        removal plan: docs/components/litellm.md "Removing the compatibility aliases");
 *     2. the chart does not set `router_settings.model_group_alias`;
 *     3. `osUI.modelRoles.seed` names the three roles, each a model in that profile's `model_list`;
 *     4. `litellmAgentKey.models` holds the three role names, and every router fallback source/target.
 *   `ROLE_CATALOG_TWIN=old-alias|seed-outside-catalog|key-without-role` plants one fault in the base values so
 *   the test can prove each rule fails. Pure file reads. Wired into CI by scripts/tests/litellm-role-catalog.test.sh.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(ROOT, 'os-ui/package.json'));
const yaml = require('js-yaml');
const loadYaml = (p) => yaml.load(readFileSync(resolve(ROOT, p), 'utf8')) ?? {};
const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function merge(base, overlay) {
  if (!isMap(base) || !isMap(overlay)) return overlay === undefined ? base : overlay;
  const out = { ...base };
  for (const [k, v] of Object.entries(overlay)) out[k] = merge(base[k], v);
  return out;
}
const ROLES = ['sovereign-strong', 'sovereign-worker', 'sovereign-embedding'];
const OLD = ['sovereign-default', 'sovereign-mock', 'sovereign-reasoning', 'sovereign-reasoning-fast', 'sovereign-premium', 'sovereign-vision', 'sovereign-embed'];

function check(name, v, { compatAliases = false } = {}) {
  const problems = [];
  const pc = v.litellm?.proxy_config ?? {};
  const names = (Array.isArray(pc.model_list) ? pc.model_list : []).map((m) => m?.model_name);
  if (!names.length) problems.push('model_list is empty');
  for (const n of names) {
    if (OLD.includes(n) && !compatAliases) problems.push(`model_list holds the old alias ${n}: the catalog uses real names, and the old names are aliases the OS writes through the API`);
    if (ROLES.includes(n)) problems.push(`model_list holds the role name ${n}: a role is an alias the OS writes, not a catalog model`);
  }
  if (pc.router_settings?.model_group_alias !== undefined) problems.push('router_settings.model_group_alias is set in the chart: LiteLLM then refuses to change it through the API');
  const seed = v.osUI?.modelRoles?.seed ?? {};
  for (const r of ROLES) {
    if (!seed[r]) problems.push(`osUI.modelRoles.seed.${r} is missing`);
    else if (!names.includes(seed[r])) problems.push(`osUI.modelRoles.seed.${r} → ${seed[r]} is not in model_list (${names.join(', ')})`);
  }
  const keyModels = v.litellmAgentKey?.models ?? [];
  for (const r of ROLES) if (!keyModels.includes(r)) problems.push(`litellmAgentKey.models lacks ${r}: a remap would be refused on the shared key`);
  const rs = pc.router_settings ?? {};
  for (const key of ['fallbacks', 'context_window_fallbacks', 'content_policy_fallbacks']) {
    for (const entry of Array.isArray(rs[key]) ? rs[key] : []) {
      for (const [from, targets] of Object.entries(entry ?? {})) {
        for (const t of [from, ...(Array.isArray(targets) ? targets : [])]) if (!keyModels.includes(t)) problems.push(`router_settings.${key}: ${t} is not on litellmAgentKey.models`);
      }
    }
  }
  return { name, problems };
}

let base = loadYaml('charts/sovereign-agentic-os/values.yaml');
const catalog = loadYaml('deploy/gateway-models.yaml');
const twin = process.env.ROLE_CATALOG_TWIN;
if (twin === 'old-alias') base = merge(base, { litellm: { proxy_config: { model_list: [...base.litellm.proxy_config.model_list, { model_name: 'sovereign-default' }] } } });
if (twin === 'seed-outside-catalog') base = merge(base, { osUI: { modelRoles: { seed: { 'sovereign-strong': 'ghost-model' } } } });
if (twin === 'key-without-role') base = merge(base, { litellmAgentKey: { models: base.litellmAgentKey.models.filter((m) => m !== 'sovereign-strong') } });
const results = [
  check('values.yaml (base)', base),
  check('values.stackit-managed.yaml (over base)', merge(base, loadYaml('values.stackit-managed.yaml'))),
  check('dev: values.dev.yaml + deploy/gateway-models.yaml (over base)', merge(merge(base, loadYaml('values.dev.yaml')), catalog), { compatAliases: true }),
  check('prod: deploy/gateway-models.yaml (over base)', merge(base, catalog), { compatAliases: true }),
];
const bad = results.filter((r) => r.problems.length);
if (bad.length) {
  for (const r of bad) { console.error(`check-litellm-role-catalog: ${r.name}`); for (const p of r.problems) console.error(`  - ${p}`); }
  process.exit(1);
}
console.log('check-litellm-role-catalog: ok — real catalog names, role seeds inside the catalog, keys allow the three roles');
