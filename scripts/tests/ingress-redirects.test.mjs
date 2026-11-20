// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// `ingress.redirectHosts` (templates/base/ingress-redirects.yaml): a second hostname that only
// REDIRECTS (308, path + query kept) to the canonical OS URL (osUI.publicUrl by default), with its own cert-manager
// certificate and no backend to os-ui. Proves, on `helm template`:
//   - the redirect Ingress renders with exactly those annotations, TLS and a non-os-ui backend;
//   - every other rendered object (the canonical os-ui Ingress, OS_PUBLIC_URL, cookies, MCP URL)
//     is byte-identical with and without the list;
//   - an empty list renders nothing;
//   - negative twins: a `to` with a path, `ingress.enabled=false`, a host that is also served,
//     and a duplicate host all refuse to render.
// The real-controller proof (ingress-nginx v1.11.3 answers 308 with the path and query) is
// tests/ingress/redirect.kind.sh. Run: needs helm + `helm dependency build`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHART = join(ROOT, 'charts', 'sovereign-agentic-os');
// Production's shape (read live 2026-11-20): OS_PUBLIC_URL = https://agentic.datamasterclass.com
// (served by the apex Ingress); os.agentic.datamasterclass.com is an extra host serving the OS.
const BASE = ['ingress.enabled=true', 'ingress.hosts.osUI=os.agentic.datamasterclass.com', 'ingress.hosts.osUIApex=agentic.datamasterclass.com', 'osUI.publicUrl=https://agentic.datamasterclass.com'];
const REDIRECT = ['ingress.redirectHosts[0].host=platform.sovereign-agentic.com']; // no `to`: osUI.publicUrl

function render(sets) {
  const args = ['template', 'agentic-os', CHART, '-n', 'agentic-os'];
  for (const s of sets) args.push('--set', s);
  return spawnSync('helm', args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
}
const docs = (out) => out.split(/^---$/m).map((d) => d.trim()).filter((d) => d.includes('kind:'));
const isRedirect = (d) => d.includes('app.kubernetes.io/component: ingress-redirect');

test('the redirect Ingress: 308 + $request_uri to osUI.publicUrl, own certificate, no os-ui backend', () => {
  const r = render([...BASE, ...REDIRECT]);
  assert.equal(r.status, 0, r.stderr);
  const red = docs(r.stdout).filter(isRedirect);
  assert.equal(red.length, 1);
  const d = red[0];
  assert.match(d, /kind: Ingress\n/);
  assert.match(d, /name: redirect-platform-sovereign-agentic-com\n/);
  assert.match(d, /cert-manager\.io\/cluster-issuer: "letsencrypt-prod"/);
  assert.match(d, /nginx\.ingress\.kubernetes\.io\/permanent-redirect: "https:\/\/agentic\.datamasterclass\.com\$request_uri"/);
  assert.match(d, /nginx\.ingress\.kubernetes\.io\/permanent-redirect-code: "308"/);
  assert.match(d, /ingressClassName: nginx/);
  assert.match(d, /- "platform\.sovereign-agentic\.com"\n\s+secretName: "platform\.sovereign-agentic\.com-tls"/);
  assert.match(d, /- host: "platform\.sovereign-agentic\.com"/);
  assert.doesNotMatch(d, /name: os-ui\b/, 'no backend to os-ui');
  assert.match(d, /name: redirect-only/);
});

/** Keys whose value the chart generates at random per render (local dev secrets): masked, never printed. */
function volatileKeys(x, y) {
  const a = x.split('\n'), b = y.split('\n');
  const keys = new Set();
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) keys.add(a[i].trim().split(':')[0]);
  return keys;
}
const mask = (out, keys) => out.split('\n').map((l) => (keys.has(l.trim().split(':')[0]) ? `${l.split(':')[0]}: <generated>` : l)).join('\n');
const nameOf = (d) => (d.match(/^kind: (\S+)/m)?.[1] ?? '?') + '/' + (d.match(/^  name: (\S+)/m)?.[1] ?? '?');

test('the canonical Ingress and every other object are unchanged by the redirect list', () => {
  const without = render(BASE);
  const again = render(BASE);
  const withR = render([...BASE, ...REDIRECT]);
  assert.equal(without.status, 0, without.stderr);
  assert.equal(withR.status, 0, withR.stderr);
  const keys = volatileKeys(without.stdout, again.stdout);
  const a = docs(mask(without.stdout, keys));
  const b = docs(mask(withR.stdout, keys)).filter((d) => !isRedirect(d));
  assert.equal(b.length, a.length);
  const changed = a.filter((d, i) => d !== b[i]).map(nameOf);
  assert.deepEqual(changed, [], 'objects changed by the redirect list');
  const canonical = a.find((d) => d.includes('name: os-ui-ingress'));
  assert.ok(canonical, 'the canonical os-ui Ingress renders');
  assert.match(canonical, /- host: "os\.agentic\.datamasterclass\.com"/);
  assert.match(canonical, /name: os-ui\n\s+port:\n\s+number: 3000/);
  assert.match(without.stdout, /name: OS_PUBLIC_URL\n\s+value: "https:\/\/agentic\.datamasterclass\.com"/);
  assert.ok(a.find((d) => d.includes('name: os-ui-apex-ingress')), 'the apex Ingress (the canonical host) renders unchanged');
});

test('the target follows osUI.publicUrl (a trailing slash dropped); an explicit `to` overrides it', () => {
  const ann = (sets) => {
    const r = render(sets);
    assert.equal(r.status, 0, r.stderr);
    return docs(r.stdout).filter(isRedirect)[0].match(/permanent-redirect: "([^"]+)"/)[1];
  };
  assert.equal(ann([...BASE, ...REDIRECT, 'osUI.publicUrl=https://agentic.datamasterclass.com/']), 'https://agentic.datamasterclass.com$request_uri');
  assert.equal(ann([...BASE, ...REDIRECT, 'osUI.publicUrl=https://os.example.org']), 'https://os.example.org$request_uri', 'derived, not hard-coded');
  assert.equal(ann([...BASE, ...REDIRECT, 'ingress.redirectHosts[0].to=https://other.example.org']), 'https://other.example.org$request_uri');
});

test('an empty list (the default) renders no redirect Ingress', () => {
  for (const sets of [BASE, [...BASE, 'ingress.redirectHosts=null'], []]) {
    const r = render(sets);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(docs(r.stdout).filter(isRedirect).length, 0);
  }
});

test('NEGATIVE: unsafe or contradictory entries refuse to render', () => {
  const cases = [
    [[...BASE, REDIRECT[0], 'ingress.redirectHosts[0].to=https://os.agentic.datamasterclass.com/login'], /must be an https origin/],
    [[...BASE, REDIRECT[0], 'osUI.publicUrl=https://agentic.datamasterclass.com/os'], /must be an https origin/],
    [[...BASE, REDIRECT[0], 'osUI.publicUrl='], /osUI\.publicUrl is empty/],
    [[...BASE, REDIRECT[0], 'ingress.redirectHosts[0].to=http://os.agentic.datamasterclass.com'], /must be an https origin/],
    [[...BASE, REDIRECT[0], 'ingress.redirectHosts[0].to=https://os.agentic.datamasterclass.com$request_uri'], /must be an https origin/],
    [['ingress.enabled=false', ...REDIRECT], /needs ingress\.enabled=true/],
    [[...BASE, 'ingress.redirectHosts[0].host=os.agentic.datamasterclass.com', 'ingress.redirectHosts[0].to=https://platform.sovereign-agentic.com'], /is also ingress\.hosts\.osUI/],
    [[...BASE, ...REDIRECT, 'ingress.redirectHosts[1].host=platform.sovereign-agentic.com'], /lists platform\.sovereign-agentic\.com twice/],
    [[...BASE, 'ingress.redirectHosts[0].host=agentic.datamasterclass.com'], /redirects agentic\.datamasterclass\.com to itself|is also ingress\.hosts\.osUIApex/],
    [[...BASE, 'ingress.redirectHosts[0].host=Platform.Example.com'], /not a lower-case DNS name/],
  ];
  for (const [sets, why] of cases) {
    const r = render(sets);
    assert.notEqual(r.status, 0, `must refuse: ${sets.join(' ')}`);
    assert.match(r.stderr, why);
  }
});
