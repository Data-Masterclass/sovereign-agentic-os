#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Chart test — the scoped agent key's model allowlist covers every alias the OS can request.
 * USER STORY: As an operator I never again ship a key that 403s on `sovereign-default` because a
 *             config default, a runtime model or a router fallback target was added without the
 *             allowlist following (the production incident `docs/components/litellm.md` records).
 * ARCHITECTURE:
 *   For each profile (base `values.yaml`, and `values.stackit-managed.yaml` layered over it the way
 *   Helm merges values — maps deep-merge, lists replace), the REQUIRED set is:
 *     • every `LITELLM_*_MODEL` / `*_EMBED_MODEL` default literal in `os-ui/core/kernel/config.ts`;
 *     • `agentRuntime.chatModel` / `reasoningModel` / `executionModel`;
 *     • every `router_settings.fallbacks` source AND target alias.
 *   and it must be ⊆ `litellmAgentKey.models`. Exit 1 with the gap named. Wired into
 *   `os-ui/scripts/gate.sh` (checklist A28). Pure file reads — no cluster, no network.
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

/** Helm-style values merge: maps deep-merge, everything else (lists, scalars) is replaced. */
function merge(base, overlay) {
  if (!isMap(base) || !isMap(overlay)) return overlay === undefined ? base : overlay;
  const out = { ...base };
  for (const [k, v] of Object.entries(overlay)) out[k] = merge(base[k], v);
  return out;
}
const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The default alias literals of the model-selecting config keys (nested env() calls included). */
function configModelDefaults(src) {
  const out = new Set();
  for (const line of src.split('\n')) {
    if (!/\b(LITELLM_[A-Z_]*MODEL|KNOWLEDGE_EMBED_MODEL|FILES_EMBED_MODEL)\b/.test(line)) continue;
    for (const m of line.matchAll(/'([^']+)'/g)) {
      const lit = m[1];
      if (/^[A-Z][A-Z0-9_]*$/.test(lit)) continue; // an env var NAME, not a default
      out.add(lit);
    }
  }
  return out;
}

function required(values, configSrc) {
  const need = new Map(); // alias → reasons
  const add = (alias, why) => {
    if (!alias || typeof alias !== 'string') return;
    if (!need.has(alias)) need.set(alias, []);
    need.get(alias).push(why);
  };
  for (const a of configModelDefaults(configSrc)) add(a, 'core/kernel/config.ts default');
  const rt = values.agentRuntime ?? {};
  for (const k of ['chatModel', 'reasoningModel', 'executionModel']) add(rt[k], `agentRuntime.${k}`);
  const fallbacks = values.litellm?.proxy_config?.router_settings?.fallbacks ?? [];
  for (const entry of Array.isArray(fallbacks) ? fallbacks : []) {
    if (!isMap(entry)) continue;
    for (const [from, targets] of Object.entries(entry)) {
      add(from, 'router_settings.fallbacks source');
      for (const t of Array.isArray(targets) ? targets : []) add(t, `router_settings.fallbacks target of ${from}`);
    }
  }
  return need;
}

const configSrc = read('os-ui/core/kernel/config.ts');
const base = loadYaml('charts/sovereign-agentic-os/values.yaml');
const profiles = [
  { name: 'values.yaml (base)', values: base },
  { name: 'values.stackit-managed.yaml (over base)', values: merge(base, loadYaml('values.stackit-managed.yaml')) },
];

let failed = false;
for (const { name, values } of profiles) {
  const allow = new Set(values.litellmAgentKey?.models ?? []);
  const need = required(values, configSrc);
  const missing = [...need.keys()].filter((a) => !allow.has(a));
  console.log(`\n${name}`);
  console.log(`  litellmAgentKey.models: ${[...allow].join(', ') || '(none)'}`);
  console.log(`  required (${need.size}): ${[...need.keys()].join(', ')}`);
  if (missing.length === 0) {
    console.log('  OK — every requestable alias is on the key allowlist');
  } else {
    failed = true;
    for (const a of missing) console.log(`  MISSING ${a}  <- ${need.get(a).join('; ')}`);
  }
}
if (failed) {
  console.error('\ncheck-litellm-allowlist: FAIL — add the missing aliases to litellmAgentKey.models (the key would 403 on them).');
  process.exit(1);
}
console.log('\ncheck-litellm-allowlist: PASS');
