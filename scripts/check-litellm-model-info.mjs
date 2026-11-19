#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       repo tooling
 * FEATURE:    Chart test — every gateway alias is priced, its capabilities match the OS, and the
 *             gateway keeps prompt content out of its own records.
 * USER STORY: As an operator I never again run a gateway whose budgets cannot trigger. The model
 *             ids behind our aliases are custom, so LiteLLM's price map does not know them: with
 *             no `model_info` price every call is booked at cost 0, key spend never moves and a
 *             budget is decoration — which is how this stack ran until 2026-11-19. And as the
 *             data owner I want the build to fail if someone removes the gateway's redaction.
 * ARCHITECTURE:
 *   For each profile (base `values.yaml`; `values.stackit-managed.yaml` merged over it the way
 *   Helm merges values — maps deep-merge, lists replace; and the one-time production overlay
 *   `deploy/overlays/gateway-model-info.stackit.yaml` over both) it asserts:
 *     1. every `litellm.proxy_config.model_list` entry has `model_info` with numeric, non-negative
 *        `input_cost_per_token` and `output_cost_per_token`, and a `mode`;
 *     2. where `osUI.modelPricesJson` (the OS price book, per 1M tokens) names the alias, the
 *        gateway price is the same number per token — two ledgers, one price;
 *     3. aliases that point at the same upstream model carry the same prices;
 *     4. `supports_vision` is true exactly for the aliases on the OS image allowlist
 *        (`DEFAULT_IMAGE_MODELS` in os-ui/core/models/capabilities.ts), and only ever for an
 *        alias that points at a Qwen3-VL chat model;
 *     5. `router_settings.enable_pre_call_checks` is not on unless every chat alias carries
 *        `max_input_tokens` (LiteLLM would otherwise filter on a guess);
 *     6. `litellm_settings.turn_off_message_logging` is true and
 *        `general_settings.store_prompts_in_spend_logs` is not true;
 *     7. the shared key has a positive `maxBudget` AND a `budgetDuration` (a lifetime cap ends in
 *        a permanent outage).
 *   Pure file reads — no helm, no cluster, no network — so it never skips. Wired into
 *   `os-ui/scripts/gate.sh`. docs/components/litellm.md "Prices and budgets" explains the rules.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(ROOT, 'os-ui/package.json'));
const yaml = require('js-yaml');

const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
const loadYaml = (p) => yaml.load(read(p)) ?? {};
const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** Helm-style values merge: maps deep-merge, everything else (lists, scalars) is replaced. */
function merge(base, overlay) {
  if (!isMap(base) || !isMap(overlay)) return overlay === undefined ? base : overlay;
  const out = { ...base };
  for (const [k, v] of Object.entries(overlay)) out[k] = merge(base[k], v);
  return out;
}

/** The frozen array literal of `DEFAULT_IMAGE_MODELS` — the OS's own answer to "may see images". */
function imageAllowlist() {
  const src = read('os-ui/core/models/capabilities.ts');
  const m = /DEFAULT_IMAGE_MODELS[^=]*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/.exec(src);
  if (!m) throw new Error('could not find DEFAULT_IMAGE_MODELS in os-ui/core/models/capabilities.ts');
  return new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
}

const EPS = 1e-15;
const same = (a, b) => Math.abs(a - b) <= EPS;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

function check(name, values, images) {
  const problems = [];
  const pc = values.litellm?.proxy_config ?? {};
  const list = Array.isArray(pc.model_list) ? pc.model_list : [];
  if (!list.length) problems.push('litellm.proxy_config.model_list is empty');

  let book = {};
  try {
    book = JSON.parse(values.osUI?.modelPricesJson || '{}');
  } catch {
    problems.push('osUI.modelPricesJson is not valid JSON');
  }

  const byUpstream = new Map();
  let chatWithoutWindow = 0;
  for (const entry of list) {
    const alias = entry?.model_name;
    const upstream = String(entry?.litellm_params?.model ?? '');
    const info = entry?.model_info;
    if (!isMap(info)) {
      problems.push(`${alias}: no model_info — LiteLLM books every call on it at cost 0, so no budget can trigger`);
      continue;
    }
    const inP = num(info.input_cost_per_token);
    const outP = num(info.output_cost_per_token);
    if (inP === null) problems.push(`${alias}: model_info.input_cost_per_token must be a non-negative number (got ${JSON.stringify(info.input_cost_per_token)})`);
    if (outP === null) problems.push(`${alias}: model_info.output_cost_per_token must be a non-negative number (got ${JSON.stringify(info.output_cost_per_token)})`);
    if (!info.mode) problems.push(`${alias}: model_info.mode is missing (chat | embedding)`);

    const priced = book[alias];
    if (priced && inP !== null && outP !== null) {
      if (!same(inP, Number(priced.inputPerM) / 1e6)) problems.push(`${alias}: input price ${inP} per token disagrees with osUI.modelPricesJson (${priced.inputPerM} per 1M = ${Number(priced.inputPerM) / 1e6} per token)`);
      if (!same(outP, Number(priced.outputPerM) / 1e6)) problems.push(`${alias}: output price ${outP} per token disagrees with osUI.modelPricesJson (${priced.outputPerM} per 1M = ${Number(priced.outputPerM) / 1e6} per token)`);
    }
    if (inP !== null && outP !== null) {
      const seen = byUpstream.get(upstream);
      if (seen && (!same(seen.inP, inP) || !same(seen.outP, outP))) problems.push(`${alias}: priced ${inP}/${outP} but ${seen.alias}, which points at the same model (${upstream}), is priced ${seen.inP}/${seen.outP}`);
      if (!seen) byUpstream.set(upstream, { alias, inP, outP });
    }

    const vision = info.supports_vision === true;
    if (vision !== images.has(alias)) {
      problems.push(
        vision
          ? `${alias}: supports_vision is true but the alias is NOT on the OS image allowlist (os-ui/core/models/capabilities.ts DEFAULT_IMAGE_MODELS)`
          : `${alias}: on the OS image allowlist but model_info.supports_vision is not true`,
      );
    }
    if (vision && !(info.mode === 'chat' && /Qwen3-VL-\d+B/i.test(upstream))) problems.push(`${alias}: supports_vision is true but it does not point at a Qwen3-VL chat model (${upstream})`);
    if (info.mode === 'chat' && typeof info.max_input_tokens !== 'number') chatWithoutWindow++;
  }

  if (pc.router_settings?.enable_pre_call_checks === true && chatWithoutWindow > 0) {
    problems.push(`router_settings.enable_pre_call_checks is on but ${chatWithoutWindow} chat alias(es) carry no model_info.max_input_tokens`);
  }
  if (pc.litellm_settings?.turn_off_message_logging !== true) {
    problems.push('litellm_settings.turn_off_message_logging is not true — the gateway would log every prompt and completion to Langfuse, past the OS redaction');
  }
  if (pc.general_settings?.store_prompts_in_spend_logs === true || String(pc.general_settings?.store_prompts_in_spend_logs).toLowerCase() === 'true') {
    problems.push('general_settings.store_prompts_in_spend_logs is true — prompts would be stored in the gateway database');
  }
  const key = values.litellmAgentKey ?? {};
  if (key.enabled !== false) {
    if (!(Number(key.maxBudget) > 0)) problems.push(`litellmAgentKey.maxBudget must be > 0 (got ${JSON.stringify(key.maxBudget)})`);
    if (!key.budgetDuration) problems.push('litellmAgentKey.budgetDuration is empty — a lifetime cap never resets; once spent, every caller of the shared key is refused until an admin intervenes');
  }
  return { name, problems, aliases: list.length };
}

const base = loadYaml('charts/sovereign-agentic-os/values.yaml');
const images = imageAllowlist();
const results = [
  check('values.yaml (base)', base, images),
  check('values.stackit-managed.yaml (over base)', merge(base, loadYaml('values.stackit-managed.yaml')), images),
  // The one-time overlay for a cluster that carries its own model_list (production): a copy of a
  // list is exactly the thing that rots, so it is held to the same rules.
  check(
    'deploy/overlays/gateway-model-info.stackit.yaml (over both)',
    merge(merge(base, loadYaml('values.stackit-managed.yaml')), loadYaml('deploy/overlays/gateway-model-info.stackit.yaml')),
    images,
  ),
];
const failed = results.filter((r) => r.problems.length);
if (failed.length) {
  console.error('check-litellm-model-info FAILED:');
  for (const r of failed) {
    console.error(`  ${r.name}`);
    for (const p of r.problems) console.error(`    - ${p}`);
  }
  process.exit(1);
}
console.log(`check-litellm-model-info: ok — ${results.map((r) => `${r.aliases} aliases priced on ${r.name}`).join('; ')}; vision flags match the OS image allowlist; gateway redaction is on; the shared key's budget resets`);
