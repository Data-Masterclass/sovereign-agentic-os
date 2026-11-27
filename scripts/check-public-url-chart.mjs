#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    publicUrl / publicUrlAliases / insecureSessionCookie work WITHOUT the chart's Ingress
 * USER STORY: As an operator who runs the OS behind my own reverse proxy (or on http://<server>:8080 for a test), I
 *             want to tell os-ui its public origin(s) and, for a throw-away test only, an insecure session cookie,
 *             through chart values — not by finding env names in the code.
 * ARCHITECTURE:
 *   - Renders the chart (`helm template`) and reads the os-ui Deployment's env:
 *     osUI.publicUrl → OS_PUBLIC_URL; osUI.publicUrlAliases (list or comma string) → OS_PUBLIC_URL_ALIASES, with
 *     ingress.enabled=false; merged with the Ingress's second host when the Ingress is on; the publicUrl itself is
 *     never repeated as an alias; osUI.insecureSessionCookie=true → OS_SESSION_COOKIE_INSECURE="true"; NOTES.txt
 *     carries the NOT-FOR-PRODUCTION note under that switch (checked statically: no cluster needed).
 *   - Negative twins: the defaults render neither OS_PUBLIC_URL_ALIASES nor OS_SESSION_COOKIE_INSECURE; an alias with
 *     a path or without a scheme fails the render (os-ui would drop it silently); no committed profile turns the
 *     insecure cookie on.
 *   - Same skip rules as check-alias-redirect-chart.mjs (no helm / no subchart .tgz → skip, FAIL in CI).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHART = join(ROOT, 'charts', 'sovereign-agentic-os');
const problems = [];
const fail = (m) => problems.push(m);

function skipReason() {
  try { execFileSync('helm', ['version', '--short'], { stdio: 'ignore' }); } catch { return 'helm not on PATH'; }
  const dir = join(CHART, 'charts');
  if (!(existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.tgz')))) return 'no subchart .tgz (run `helm dependency build charts/sovereign-agentic-os`)';
  return '';
}

function render(sets) {
  const args = ['template', 't', CHART, '--set', 'global.allowChartDefaultSecrets=true'];
  for (const s of sets) args.push('--set', s);
  try {
    return { ok: true, out: execFileSync('helm', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 27 }) };
  } catch (e) {
    return { ok: false, out: String(e.stderr ?? e.message) };
  }
}

/** The os-ui Deployment's env as name → value (only literal `value:` entries). */
function osUiEnv(out) {
  for (const doc of out.split(/^---$/m)) {
    if (!/^kind: Deployment$/m.test(doc) || !/^  name: os-ui$/m.test(doc)) continue;
    const env = {};
    for (const m of doc.matchAll(/- name: ([A-Z0-9_]+)\n\s+value: "?([^"\n]*)"?/g)) env[m[1]] = m[2];
    return env;
  }
  return null;
}

// Static: no committed profile turns the insecure cookie on.
for (const f of ['charts/sovereign-agentic-os/values.yaml', 'values.yaml', 'values.local.yaml', 'values.stackit-managed.yaml', 'values.dev.yaml']) {
  const p = join(ROOT, f);
  if (existsSync(p) && /^\s*insecureSessionCookie:\s*true/m.test(readFileSync(p, 'utf8'))) fail(`${f} turns osUI.insecureSessionCookie on`);
}

// NOTES.txt (not rendered by `helm template`, and `helm install --dry-run` needs a cluster): the
// NOT-FOR-PRODUCTION note sits inside an `if .Values.osUI.insecureSessionCookie` block.
{
  const notes = readFileSync(join(CHART, 'templates', 'NOTES.txt'), 'utf8');
  const block = notes.match(/\{\{-? if \.Values\.osUI\.insecureSessionCookie \}\}([\s\S]*?)\{\{-? end \}\}/);
  if (!block || !/NOT FOR PRODUCTION/.test(block[1])) fail('NOTES.txt must print a NOT-FOR-PRODUCTION note inside `if .Values.osUI.insecureSessionCookie`');
}

const skipped = skipReason();
if (!skipped) {
  // Defaults: neither variable.
  let r = render([]);
  if (!r.ok) fail(`default render failed: ${r.out.trim()}`);
  else {
    const env = osUiEnv(r.out);
    if (!env) fail('no os-ui Deployment in the default render');
    else {
      if ('OS_PUBLIC_URL_ALIASES' in env) fail(`default renders OS_PUBLIC_URL_ALIASES=${env.OS_PUBLIC_URL_ALIASES}`);
      if ('OS_SESSION_COOKIE_INSECURE' in env) fail('default renders OS_SESSION_COOKIE_INSECURE');
    }
  }
  // Without the Ingress: publicUrl + aliases (list form) reach os-ui; the publicUrl is not repeated as an alias.
  r = render(['ingress.enabled=false', 'osUI.publicUrl=https://os.example.com',
    'osUI.publicUrlAliases={https://os.example.com,http://10.0.0.5:8080,https://os2.example.com/}']);
  if (!r.ok) fail(`render (aliases, no ingress) failed: ${r.out.trim()}`);
  else {
    const env = osUiEnv(r.out) ?? {};
    if (env.OS_PUBLIC_URL !== 'https://os.example.com') fail(`OS_PUBLIC_URL must be the publicUrl without the Ingress; got ${env.OS_PUBLIC_URL}`);
    if (env.OS_PUBLIC_URL_ALIASES !== 'http://10.0.0.5:8080,https://os2.example.com') fail(`OS_PUBLIC_URL_ALIASES (no ingress) wrong: ${env.OS_PUBLIC_URL_ALIASES}`);
  }
  // An IPv6 literal origin is accepted.
  r = render(['osUI.publicUrlAliases={http://[fd00::5]:8080}']);
  if (!r.ok) fail(`render (IPv6 alias) failed: ${r.out.trim()}`);
  else if ((osUiEnv(r.out) ?? {}).OS_PUBLIC_URL_ALIASES !== 'http://[fd00::5]:8080') fail(`an IPv6 alias must render; got ${(osUiEnv(r.out) ?? {}).OS_PUBLIC_URL_ALIASES}`);
  // Comma-string form works too.
  r = render(['osUI.publicUrlAliases=http://10.0.0.5:8080']);
  if (!r.ok) fail(`render (string alias) failed: ${r.out.trim()}`);
  else if ((osUiEnv(r.out) ?? {}).OS_PUBLIC_URL_ALIASES !== 'http://10.0.0.5:8080') fail('a single string alias must render as OS_PUBLIC_URL_ALIASES');
  // With the Ingress on: the second Ingress host AND the explicit alias are merged.
  r = render(['ingress.enabled=true', 'ingress.hosts.osUI=os.example.com', 'ingress.hosts.osUIApex=example.com',
    'osUI.publicUrl=https://example.com', 'osUI.publicUrlAliases={https://internal.example.net}']);
  if (!r.ok) fail(`render (ingress + alias) failed: ${r.out.trim()}`);
  else {
    const a = (osUiEnv(r.out) ?? {}).OS_PUBLIC_URL_ALIASES;
    if (a !== 'https://os.example.com,https://internal.example.net') fail(`ingress host + explicit alias must merge; got ${a}`);
  }
  // Insecure cookie: explicit opt-in renders the variable and the NOTES warning.
  r = render(['osUI.insecureSessionCookie=true']);
  if (!r.ok) fail(`render (insecure cookie) failed: ${r.out.trim()}`);
  else if ((osUiEnv(r.out) ?? {}).OS_SESSION_COOKIE_INSECURE !== 'true') fail('osUI.insecureSessionCookie=true must render OS_SESSION_COOKIE_INSECURE="true"');
  // TWINS: malformed aliases fail the render (never silently dropped by os-ui).
  for (const bad of ['https://os.example.com/os', 'os.example.com', 'ftp://os.example.com', 'http://[fd00::5/x]']) {
    r = render([`osUI.publicUrlAliases={${bad}}`]);
    if (r.ok || !/osUI\.publicUrlAliases: .* must be an origin/.test(r.out)) fail(`alias ${bad} must fail the render`);
  }
}

if (problems.length) {
  console.error('check-public-url-chart FAILED:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
if (skipped) {
  if (process.env.CI) { console.error(`check-public-url-chart: ${skipped} — FAILING because CI is set.`); process.exit(1); }
  console.log(`check-public-url-chart: ${skipped} — SKIPPED`);
  process.exit(0);
}
console.log('check-public-url-chart: ok — publicUrl, publicUrlAliases (list or string, merged with the Ingress host) and insecureSessionCookie reach os-ui without the Ingress, the defaults render neither, malformed aliases fail the render, and the insecure cookie prints a NOT-FOR-PRODUCTION note');
