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
 *     6. `litellm_settings.turn_off_message_logging` is true,
 *        `general_settings.store_prompts_in_spend_logs` is not true, and
 *        `litellm_settings.failure_callback` does not send to Langfuse (a request the proxy
 *        refuses is logged with its full body, which the redaction switch does not cover);
 *     7. the shared key has a positive `maxBudget` AND a `budgetDuration` (a lifetime cap ends in
 *        a permanent outage);
 *     8. the gateway traces through ONE Langfuse callback: `litellm_settings.callbacks` holds
 *        `langfuse_otel`, no callback list holds the legacy `langfuse`, `litellm.envVars` sets
 *        `LITELLM_OTEL_V2: "true"` and a valid `LITELLM_OTEL_LANGFUSE_SPAN_SCOPE` (`full` |
 *        `llm_only`; anything else silently disables OTel v2), and under `full` a
 *        `LITELLM_OTEL_BAGGAGE_PROMOTED_KEYS` without the model keys (else every span of a request
 *        is a GENERATION). Both callbacks together log every call twice (LiteLLM's migration
 *        guide; scripts/tests/litellm-langfuse proves it).
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
  const failureCallbacks = [].concat(pc.litellm_settings?.failure_callback ?? []);
  if (failureCallbacks.some((c) => /^langfuse/.test(String(c)))) {
    problems.push(`litellm_settings.failure_callback contains ${JSON.stringify(failureCallbacks)} — for a request the proxy refuses (rate limit, budget, model not allowed) LiteLLM logs the full request body to Langfuse, and turn_off_message_logging does not redact it`);
  }
  const callbackLists = { callbacks: pc.litellm_settings?.callbacks, success_callback: pc.litellm_settings?.success_callback, failure_callback: pc.litellm_settings?.failure_callback };
  for (const [field, v] of Object.entries(callbackLists)) {
    if ([].concat(v ?? []).some((c) => String(c) === 'langfuse')) {
      problems.push(`litellm_settings.${field} contains the legacy "langfuse" callback — next to "langfuse_otel" every model call is logged twice, and Langfuse v4 rejects it`);
    }
  }
  if (![].concat(pc.litellm_settings?.callbacks ?? []).includes('langfuse_otel')) {
    problems.push('litellm_settings.callbacks does not contain "langfuse_otel" — the gateway would record no generation in Langfuse');
  }
  const env = values.litellm?.envVars ?? {};
  if (String(env.LITELLM_OTEL_V2) !== 'true') problems.push(`litellm.envVars.LITELLM_OTEL_V2 must be "true" (got ${JSON.stringify(env.LITELLM_OTEL_V2)}) — without it langfuse_otel runs on the older OTel integration`);
  if (!['full', 'llm_only'].includes(String(env.LITELLM_OTEL_LANGFUSE_SPAN_SCOPE))) {
    problems.push(`litellm.envVars.LITELLM_OTEL_LANGFUSE_SPAN_SCOPE must be "full" or "llm_only" (got ${JSON.stringify(env.LITELLM_OTEL_LANGFUSE_SPAN_SCOPE)}) — an invalid value stops every OTel v2 callback from loading`);
  }
  if (String(env.LITELLM_OTEL_LANGFUSE_SPAN_SCOPE) === 'full') {
    const promoted = env.LITELLM_OTEL_BAGGAGE_PROMOTED_KEYS;
    const keys = promoted === undefined ? ['gen_ai.request.model', 'litellm.provider.model'] : String(promoted).split(',').map((k) => k.trim());
    const modelKeys = keys.filter((k) => k === 'gen_ai.request.model' || k === 'litellm.provider.model');
    if (modelKeys.length) problems.push(`litellm.envVars.LITELLM_OTEL_BAGGAGE_PROMOTED_KEYS ${promoted === undefined ? 'is unset (LiteLLM\'s default list)' : 'contains'} ${modelKeys.join(', ')} — under span scope "full" every span of a request then becomes a GENERATION in Langfuse (6 per call, measured on 1.109.1)`);
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
console.log(`check-litellm-model-info: ok — ${results.map((r) => `${r.aliases} aliases priced on ${r.name}`).join('; ')}; vision flags match the OS image allowlist; gateway redaction is on; one Langfuse callback (langfuse_otel, OTel v2); the shared key's budget resets`);
