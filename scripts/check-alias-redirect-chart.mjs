#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The OS UI's alias host 308-redirects to the canonical public URL (opt-in)
 * USER STORY: As a user who opens the OS on os.<zone> while its public URL is the apex, I want to
 *             land on the one canonical origin, so my session, the OAuth nonce cookie and the
 *             provider's callback always share it and "Connect OneDrive" never fails invalid_state.
 * ARCHITECTURE:
 *   - Renders the chart (`helm template`) and checks `ingress.redirectAliasToPublicUrl`:
 *     on → the OS UI route of the NON-canonical host carries ingress-nginx's
 *     `permanent-redirect: <publicUrl>$request_uri` + code 308, the canonical route and the /git
 *     route carry none; either host can be the canonical one.
 *   - Negative twins: off (the default and the STACKIT profile) renders no redirect; on without
 *     `osUI.publicUrl`, or with a publicUrl that has a path, fails the render; the committed STACKIT
 *     profile does not set the switch (checked statically).
 *   - Same skip rules as check-consoles-not-public.mjs (no helm / no subchart .tgz → skip, FAIL in CI).
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
  const args = ['template', 't', CHART];
  for (const s of sets) args.push('--set', s);
  try {
    return { ok: true, out: execFileSync('helm', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 27 }) };
  } catch (e) {
    return { ok: false, out: String(e.stderr ?? e.message) };
  }
}

/** Ingress name → { host, redirect } from a rendered manifest (no YAML dependency). */
function ingresses(out) {
  const res = {};
  for (const doc of out.split(/^---$/m)) {
    if (!/^kind: Ingress$/m.test(doc)) continue;
    const name = doc.match(/^metadata:\n(?:.*\n)*?  name: (\S+)/m)?.[1];
    const host = doc.match(/- host: "?([^"\s]+)"?/)?.[1];
    const redirect = doc.match(/nginx\.ingress\.kubernetes\.io\/permanent-redirect: "?([^"\n]+)"?/)?.[1] ?? null;
    const code = doc.match(/nginx\.ingress\.kubernetes\.io\/permanent-redirect-code: "?(\d+)"?/)?.[1] ?? null;
    if (name) res[name] = { host, redirect, code };
  }
  return res;
}

const BASE = ['ingress.enabled=true', 'ingress.hosts.osUI=os.agentic.example.com', 'ingress.hosts.osUIApex=agentic.example.com'];

// Static: no committed profile turns the redirect on (a deploy decision, made in the private overlay).
for (const f of ['values.yaml', 'values.stackit-managed.yaml', 'values.dev.yaml']) {
  const p = join(ROOT, f);
  if (existsSync(p) && /^\s*redirectAliasToPublicUrl:\s*true/m.test(readFileSync(p, 'utf8'))) fail(`${f} turns ingress.redirectAliasToPublicUrl on`);
}

const skipped = skipReason();
if (!skipped) {
  // ON, canonical = apex → os.<zone>'s OS UI route redirects; apex and /git do not.
  let r = render([...BASE, 'osUI.publicUrl=https://agentic.example.com', 'ingress.redirectAliasToPublicUrl=true']);
  if (!r.ok) fail(`render (canonical apex) failed: ${r.out.trim()}`);
  else {
    const i = ingresses(r.out);
    if (i['os-ui-ingress']?.redirect !== 'https://agentic.example.com$request_uri' || i['os-ui-ingress']?.code !== '308') fail(`os-ui-ingress (alias) must 308 to the apex; got ${JSON.stringify(i['os-ui-ingress'])}`);
    if (i['os-ui-apex-ingress']?.redirect) fail('the canonical (apex) route must not redirect (a loop)');
    if (!i['os-git-http-ingress']) fail('the /git route must still render on the alias host');
    else if (i['os-git-http-ingress'].redirect) fail('the /git route must never be redirected (git clients and tokens)');
  }
  // ON, canonical = os.<zone> → the apex route redirects instead.
  r = render([...BASE, 'osUI.publicUrl=https://os.agentic.example.com', 'ingress.redirectAliasToPublicUrl=true']);
  if (!r.ok) fail(`render (canonical os.) failed: ${r.out.trim()}`);
  else {
    const i = ingresses(r.out);
    if (i['os-ui-apex-ingress']?.redirect !== 'https://os.agentic.example.com$request_uri') fail(`os-ui-apex-ingress (alias) must 308 to os.<zone>; got ${JSON.stringify(i['os-ui-apex-ingress'])}`);
    if (i['os-ui-ingress']?.redirect) fail('the canonical (os.) route must not redirect');
  }
  // TWIN: off (the default) → no redirect anywhere, even with two hosts and a publicUrl.
  r = render([...BASE, 'osUI.publicUrl=https://agentic.example.com']);
  if (!r.ok) fail(`render (off) failed: ${r.out.trim()}`);
  else if (Object.values(ingresses(r.out)).some((x) => x.redirect)) fail('with redirectAliasToPublicUrl off no Ingress may redirect');
  // TWIN: on without a publicUrl, or with a path, must FAIL the render (never a redirect to nowhere).
  r = render([...BASE, 'ingress.redirectAliasToPublicUrl=true']);
  if (r.ok || !/needs osUI\.publicUrl/.test(r.out)) fail('on without osUI.publicUrl must fail the render');
  r = render([...BASE, 'osUI.publicUrl=https://agentic.example.com/os', 'ingress.redirectAliasToPublicUrl=true']);
  if (r.ok || !/must be an https origin/.test(r.out)) fail('a publicUrl with a path must fail the render');
}

if (problems.length) {
  console.error('check-alias-redirect-chart FAILED:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
if (skipped) {
  if (process.env.CI) { console.error(`check-alias-redirect-chart: ${skipped} — FAILING because CI is set.`); process.exit(1); }
  console.log(`check-alias-redirect-chart: ${skipped} — SKIPPED`);
  process.exit(0);
}
console.log('check-alias-redirect-chart: ok — the alias host 308s to osUI.publicUrl (either way round), the canonical and /git routes never redirect, off renders no redirect, and a missing or non-origin publicUrl fails the render');
