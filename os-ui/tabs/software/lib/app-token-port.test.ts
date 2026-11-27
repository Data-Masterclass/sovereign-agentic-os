/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    Tests of the App Builder (E) wiring: the Software tab's port for the app token, the routes' guards, and
 *             "flag off ⇒ nothing changes" for the kernel's bearer door and the new routes.
 * USER STORY: As the OS owner I want proof that only App Builder apps the user can see get a token, that the same slug
 *             in two domains is two apps with disjoint hosts and audiences, that the scope comes from the app's real
 *             actions.yml, and that every new route answers app_builder_disabled while the switch is off.
 * ARCHITECTURE: Real apps through `createApp` (offline store, temp repos dir) and the real `app-token-sources.ts`
 *               port; the routes and the kernel door are checked at the source (a route cannot be imported in a test,
 *               os-ui/ARCHITECTURE.md), the same way the offline-mock tripwire does.
 */
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config as cfg } from '@core/kernel/config';
import type { CurrentUser } from '@core/kernel/auth';
import { appTokenScope, parseAudience } from '@core/auth/app-token';
import { appAudience } from '@tabs/software/lib/app-builder-contracts';

globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;
const { createApp } = await import('@tabs/software/lib/apps');
const { appTokenPortImpl, appCallbackHosts, appHostLabel, exclusiveCallbackHosts, isDnsLabelDomain } = await import('../../../app-token-sources.ts');

let reposDir = '';
let prior = '';
before(() => {
  reposDir = mkdtempSync(join(tmpdir(), 'os-repos-e-'));
  prior = cfg.reposDir;
  (cfg as { reposDir: string }).reposDir = reposDir;
});
after(() => {
  (cfg as { reposDir: string }).reposDir = prior;
  rmSync(reposDir, { recursive: true, force: true });
});
afterEach(() => { delete process.env.SOFTWARE_APP_BUILDER; });
const flag = (on: boolean) => { process.env.SOFTWARE_APP_BUILDER = on ? 'on' : 'off'; };

const user = (id: string, domains: string[], role: CurrentUser['role'] = 'creator'): CurrentUser => ({ id, name: id, domains, allDomains: domains, activeDomain: null, role });
const principal = (u: CurrentUser) => ({ id: u.id, name: u.name, role: u.role, domains: u.domains });

test('port: a v2 app the user can see resolves with its audience, hosts, and the write action from its actions.yml; others do not', async () => {
  flag(true);
  const alice = user('alice-e', ['sales']);
  const v2 = await createApp(alice, { name: 'Orders E', template: 'nextjs-web', templateVersion: 2 });
  const v1 = await createApp(alice, { name: 'Legacy E', template: 'nextjs-web' });
  const view = await appTokenPortImpl.appFor(principal(alice), v2.domain, v2.slug);
  assert.ok(view);
  assert.equal(view.audience.dev, `app:${v2.domain}/${v2.slug}:dev`);
  assert.equal(view.audience.prod, `app:${v2.domain}/${v2.slug}:prod`);
  assert.deepEqual(appTokenScope(view), ['action:add_order', 'read'], 'add_order (write, records) from the template actions.yml; no agents granted');
  assert.equal(view.recordsDeclared, true);
  assert.equal(await appTokenPortImpl.appFor(principal(alice), v1.domain, v1.slug), null, 'a v1 app never gets a token');
  assert.equal(await appTokenPortImpl.bySlugFor(principal(alice), v2.slug), v2.id);
  const bob = user('bob-e', ['sales']);
  assert.equal(await appTokenPortImpl.appFor(principal(bob), v2.domain, v2.slug), null, "a Personal app is not visible to another user");
});

test('same slug in two domains: two apps, disjoint audiences and callback hosts', async () => {
  flag(true);
  const a = await createApp(user('carol-e', ['sales']), { name: 'Shared Name E', template: 'nextjs-web', templateVersion: 2, domain: 'sales' });
  const b = await createApp(user('dave-e', ['hr']), { name: 'Shared Name E', template: 'nextjs-web', templateVersion: 2, domain: 'hr' });
  assert.equal(a.slug, b.slug);
  assert.notEqual(a.domain, b.domain);
  const ha = appCallbackHosts(a.domain, a.slug, 'apps.example')!;
  const hb = appCallbackHosts(b.domain, b.slug, 'apps.example')!;
  for (const env of ['dev', 'prod'] as const) for (const h of ha[env]) assert.ok(!hb.dev.includes(h) && !hb.prod.includes(h), h);
  assert.deepEqual(ha.prod, [`${a.slug}.${a.domain}.apps.example`]);
  assert.deepEqual(ha.dev, [`${a.slug}.${a.domain}.dev.apps.example`, `${a.slug}--p1.${a.domain}.dev.apps.example`, `${a.slug}--p2.${a.domain}.dev.apps.example`]);
  const va = await appTokenPortImpl.appFor(principal(user('carol-e', ['sales'])), a.domain, a.slug);
  assert.equal(await appTokenPortImpl.appFor(principal(user('carol-e', ['sales'])), b.domain, b.slug), null);
  assert.notEqual(va?.audience.dev, `app:${b.domain}/${b.slug}:dev`);
});

test('callback hosts are one app\'s alone: a non-DNS domain id gets none (no lossy mapping), and shapes two apps share are dropped from both', () => {
  assert.equal(isDnsLabelDomain('sales-eu'), true);
  for (const d of ['Sales_EU', 'sales_eu', 'Sales-EU', 'sales.eu', '-sales', 'sales-', '', 'x'.repeat(64)]) {
    assert.equal(isDnsLabelDomain(d), false, d);
    assert.equal(appCallbackHosts(d, 'orders', 'apps.example'), null, `${d}: no host, so no collision with sales-eu`);
  }
  const x = { id: 'a1', domain: 'sales', slug: 'x' };
  const xp1 = { id: 'a2', domain: 'sales', slug: 'x-p1' };
  const other = { id: 'a3', domain: 'hr', slug: 'x-p1' };
  const hx = exclusiveCallbackHosts(x, [x, xp1, other], 'apps.example')!;
  const hxp1 = exclusiveCallbackHosts(xp1, [x, xp1, other], 'apps.example')!;
  // Security review of #400: slots are `<slug>--p1`, a form no slug can take, so x's slot and x-p1's Dev host differ.
  assert.ok(hx.dev.includes('x--p1.sales.dev.apps.example'), "x's preview p1 is its own host");
  assert.ok(hxp1.dev.includes('x-p1.sales.dev.apps.example'), "x-p1's Dev host is its own host");
  assert.ok(hx.dev.includes('x.sales.dev.apps.example') && hx.dev.includes('x--p2.sales.dev.apps.example'));
  assert.deepEqual(hxp1.prod, ['x-p1.sales.apps.example'], 'hosts in another domain never collide');
  const all = [...hx.dev, ...hx.prod];
  for (const h of [...hxp1.dev, ...hxp1.prod]) assert.ok(!all.includes(h), h);
});

test('host labels stay DNS labels: a long slug is cut and keeps the app hash', () => {
  const slug = 'x'.repeat(62);
  const l = appHostLabel('sales', slug, 'p1');
  assert.ok(l.length <= 63, l);
  assert.match(l, /-[0-9a-f]{8}--p1$/);
  assert.notEqual(appHostLabel('sales', slug, 'p1'), appHostLabel('hr', slug, 'p1'));
});

test("the kernel's audience parser is the exact inverse of the contracts' appAudience", () => {
  for (const [d, sl, e] of [['sales', 'orders', 'dev'], ['Team.X_1', 'a-b-c', 'prod']] as const) {
    assert.deepEqual(parseAudience(appAudience(d, sl, e)), { domain: d, slug: sl, env: e });
  }
});

// ------------------------------------------------------------- source tripwires --
const UI = process.cwd();
function routesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...routesUnder(p));
    else if (e === 'route.ts') out.push(p);
  }
  return out;
}
const appRoutes = readdirSync(join(UI, 'app/api/auth')).filter((d) => d.startsWith('app-')).flatMap((d) => routesUnder(join(UI, 'app/api/auth', d)));

test('every new app-identity route answers app_builder_disabled first (flag off ⇒ no behaviour), and every write asks OPA', () => {
  assert.equal(appRoutes.length, 5, appRoutes.join(', '));
  for (const file of appRoutes) {
    const src = readFileSync(file, 'utf8');
    const handlers = [...src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\(/g)].map((m) => m[1]);
    assert.ok(handlers.length > 0, file);
    for (const h of handlers) {
      const body = src.slice(src.indexOf(`export async function ${h}(`)).split('\nexport ')[0];
      assert.match(body, /const off = appBuilderDisabledResponse\(\);\s*\n\s*if \(off\) return off;/, `${file} ${h} starts with the flag guard`);
      if (h !== 'GET') assert.match(body, /\bauthorize\(/, `${file} ${h} asks OPA`);
    }
    assert.doesNotMatch(src, /console\.(log|info)\([^)]*(token|code_verifier)/i, `${file} logs no token`);
  }
});

test('the kernel door: the app bearer is read only while the App Builder is on, from the sealed route header', () => {
  const auth = readFileSync(join(UI, 'core/kernel/auth.ts'), 'utf8');
  const door = auth.slice(auth.indexOf('if (appBuilderEnabled()) {'), auth.indexOf('const store = await cookies();'));
  assert.ok(door.length > 0 && door.includes('looksLikeAppToken') && door.includes('APP_ROUTE_SIG_HEADER'));
  assert.match(auth, /const real = await openAppRoute\(route, sig, config\.sessionSecret\);\s*\n\s*if \(!real\) return null;/);
  // Behaviour (forged headers on /oauth, /tools, pages and other /api routes) is proven in core/kernel/auth-app-bearer.test.ts.
});
