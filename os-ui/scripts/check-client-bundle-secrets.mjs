#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       os-ui build tooling
 * FEATURE:    Refuse development secret defaults in production (defence in depth)
 * USER STORY: As an operator I want CI to fail when a development secret default appears in a
 *             browser bundle, because everything under `.next/static` is served to anyone.
 * ARCHITECTURE:
 *   - usage: node scripts/check-client-bundle-secrets.mjs [<static dir>]   (default .next/static)
 *   - The literals come from their sources, so the list cannot drift: every quoted value in
 *     core/kernel/dev-secret-defaults.ts, plus the secret literals of the chart's values.yaml
 *     (litellmMasterKey, agentRuntime.token, langfuseInit.publicKey/secretKey, litellmUI.password)
 *     and the Langfuse init password in templates/base/langfuse/init.yaml.
 *   - Fails (exit 1) when any file under the directory contains one — naming the file and the
 *     setting, not the value — and ALSO when the directory is missing or holds no .js file: an
 *     empty scan proves nothing. `check-client-bundle-secrets.test.mjs` is its negative twin.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const osUi = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(osUi, '..');
const dir = resolve(process.argv[2] ?? join(osUi, '.next', 'static'));
const TAG = 'check-client-bundle-secrets';

/** [setting, literal] pairs from the sources of truth. */
function defaultLiterals() {
  const out = [];
  const src = readFileSync(join(osUi, 'core/kernel/dev-secret-defaults.ts'), 'utf8');
  for (const m of src.matchAll(/^\s+(\w+): SERVER \? '([^']+)' : ''/gm)) out.push([`dev-secret-defaults.${m[1]}`, m[2]]);
  if (out.length < 4) throw new Error(`${TAG}: parsed only ${out.length} literals from dev-secret-defaults.ts — the parser is out of date`);
  const values = readFileSync(join(repo, 'charts/sovereign-agentic-os/values.yaml'), 'utf8');
  const pick = (label, re) => {
    const m = values.match(re);
    if (!m) throw new Error(`${TAG}: values.yaml ${label} not found — update this check`);
    out.push([`values.yaml ${label}`, m[1]]);
  };
  pick('litellmMasterKey', /^litellmMasterKey: "([^"]+)"/m);
  pick('agentRuntime.token', /^agentRuntime:\n {2}token: "([^"]+)"/m);
  pick('langfuseInit.publicKey', /^langfuseInit:\n {2}publicKey: "([^"]+)"/m);
  pick('langfuseInit.secretKey', /^langfuseInit:\n(?: {2}.*\n)*? {2}secretKey: "([^"]+)"/m);
  pick('litellmUI.password', /^litellmUI:\n(?: {2}.*\n)*? {2}password: "([^"]+)"/m);
  const init = readFileSync(join(repo, 'charts/sovereign-agentic-os/templates/base/langfuse/init.yaml'), 'utf8');
  const pw = init.match(/LANGFUSE_INIT_USER_PASSWORD: "([^"]+)"/);
  if (!pw) throw new Error(`${TAG}: langfuse/init.yaml LANGFUSE_INIT_USER_PASSWORD not found — update this check`);
  out.push(['langfuse/init.yaml LANGFUSE_INIT_USER_PASSWORD', pw[1]]);
  return out;
}

function files(d) {
  const out = [];
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else out.push(p);
  }
  return out;
}

if (!existsSync(dir)) {
  console.error(`${TAG}: ${dir} does not exist — run \`next build\` first (an empty scan proves nothing)`);
  process.exit(1);
}
const all = files(dir);
if (!all.some((f) => f.endsWith('.js'))) {
  console.error(`${TAG}: no .js file under ${dir} — not a client build (an empty scan proves nothing)`);
  process.exit(1);
}
const literals = defaultLiterals();
const hits = [];
for (const f of all) {
  const text = readFileSync(f, 'utf8');
  for (const [setting, literal] of literals) if (text.includes(literal)) hits.push(`${relative(dir, f)}: ${setting}`);
}
if (hits.length) {
  console.error(`${TAG} FAILED — development secret defaults in the browser bundle:`);
  for (const h of hits) console.error(`  - ${h}`);
  process.exit(1);
}
console.log(`${TAG}: ok — ${literals.length} default literals, ${all.length} files under ${relative(osUi, dir) || dir}, none found`);
