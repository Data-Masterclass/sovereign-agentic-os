/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * Marketplace validation gate — end-to-end HTTP walkthrough against a running
 * os-ui (offline-mock, no cluster). Proves the golden-path gate:
 *   Sales-certified products appear → Marketing imports the metric (DIFFERENT
 *   rows via RLS) → embeds the dashboard → forks the knowledge → imports the
 *   connection template (approval → Governance) → owner sees usage → deprecating
 *   an in-use product warns importers.
 *
 * Usage:  BASE=http://localhost:3000 node scripts/marketplace-gate.mjs
 */

const BASE = process.env.BASE ?? 'http://localhost:3000';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

async function login(username, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`login ${username} failed: ${res.status}`);
  const setCookie = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')].filter(Boolean);
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error(`login ${username}: no cookie`);
  return cookie;
}

async function api(cookie, path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function rowsDomains(detail) {
  const cols = detail.preview?.columns ?? [];
  const di = cols.indexOf('domain');
  return (detail.preview?.rows ?? []).map((r) => r[di]);
}

async function main() {
  console.log(`\nMarketplace gate against ${BASE}\n`);

  const sara = await login('sara', 'sales'); // Sales admin (owner)
  const mona = await login('mona', 'marketing'); // Marketing builder (consumer)
  const mira = await login('mira', 'marketing'); // Marketing admin (for own-domain checks)

  // 1) Certified products appear with badge/owner.
  console.log('1. Discovery — certified products listed');
  const list = await api(mona, '/api/marketplace');
  const names = (list.body.items ?? []).map((i) => i.name);
  check('Revenue (metric) listed', names.includes('Revenue'));
  check('Sales Overview (dashboard) listed', names.includes('Sales Overview'));
  check('Bank submission (knowledge) listed', names.includes('Bank submission'));
  check('Salesforce (connection template) listed', names.includes('Salesforce'));
  check('adapter source reported', !!list.body.source, list.body.source);
  const byName = Object.fromEntries((list.body.items ?? []).map((i) => [i.name, i]));

  // 2) RLS divergence: Marketing vs Sales see DIFFERENT preview rows for Revenue.
  console.log('\n2. Cross-domain RLS — same metric, different rows');
  const revId = byName['Revenue'].id;
  const asMkt = await api(mona, `/api/marketplace/${revId}?as=marketing`);
  const asSales = await api(sara, `/api/marketplace/${revId}?as=sales`);
  const mktRows = rowsDomains(asMkt.body.detail);
  const salesRows = rowsDomains(asSales.body.detail);
  check('Marketing preview shows only marketing rows', mktRows.length > 0 && mktRows.every((d) => d === 'marketing'), JSON.stringify(mktRows));
  check('Sales preview shows only sales rows', salesRows.length > 0 && salesRows.every((d) => d === 'sales'), JSON.stringify(salesRows));
  check('row sets are disjoint', JSON.stringify(mktRows) !== JSON.stringify(salesRows));
  check('RLS predicate surfaced', asMkt.body.detail.preview.rlsApplied === "domain = 'marketing'", asMkt.body.detail.preview.rlsApplied);

  // 3) Import the metric → a governed read-grant, RLS-scoped to Marketing.
  console.log('\n3. Import = a governed grant (metric, read-in-place)');
  const imp = await api(mona, `/api/marketplace/${revId}/import`, { method: 'POST', body: JSON.stringify({ mode: 'read-grant', as: 'marketing' }) });
  check('import returns 201 (open auto-grant)', imp.status === 201, `status ${imp.status}`);
  check('grant active', imp.body.grant?.status === 'active');
  check('grant RLS = marketing rows', imp.body.grant?.scope?.rows === "domain = 'marketing'", imp.body.grant?.scope?.rows);
  check('enforced by Cube RLS', imp.body.grant?.enforcedBy === 'cube-rls', imp.body.grant?.enforcedBy);

  // 4) Embed the dashboard (own RLS).
  console.log('\n4. Embed the dashboard (own RLS)');
  const dash = await api(mona, `/api/marketplace/${byName['Sales Overview'].id}/import`, { method: 'POST', body: JSON.stringify({ mode: 'read-grant', as: 'marketing' }) });
  check('dashboard grant active', dash.body.grant?.status === 'active');
  check('dashboard enforced by Cube RLS', dash.body.grant?.enforcedBy === 'cube-rls');

  // 5) Fork the knowledge → editable copy owned by Marketing.
  console.log('\n5. Fork the knowledge (editable copy in Marketing)');
  const fork = await api(mona, `/api/marketplace/${byName['Bank submission'].id}/import`, { method: 'POST', body: JSON.stringify({ mode: 'fork', as: 'marketing' }) });
  check('knowledge fork active', fork.body.grant?.status === 'active');
  check('fork produced an owned copy (derivedId)', !!fork.body.grant?.derivedId, fork.body.grant?.derivedId);

  // 6) Import the connection template → approval-gated → Governance.
  console.log('\n6. Import the connection template (approval → Governance)');
  const tpl = await api(mona, `/api/marketplace/${byName['Salesforce'].id}/import`, { method: 'POST', body: JSON.stringify({ mode: 'template', as: 'marketing' }) });
  check('template import held (202 pending)', tpl.status === 202, `status ${tpl.status}`);
  check('grant pending', tpl.body.grant?.status === 'pending');
  check('grant carries an approvalId', !!tpl.body.grant?.approvalId);
  const gov = await api(sara, '/api/agent/approvals');
  const mineReq = (gov.body.approvals ?? []).find((a) => a.kind === 'marketplace_import' && a.id === tpl.body.grant.approvalId);
  check('request shows in Governance inbox (owner domain)', !!mineReq, mineReq?.title);

  // 7) Owner approves → grant activates.
  console.log('\n7. Governance approves → grant activates');
  const dec = await api(sara, '/api/agent/approvals', { method: 'POST', body: JSON.stringify({ id: tpl.body.grant.approvalId, decision: 'approve' }) });
  check('approval applied', dec.body.approval?.status === 'approved', dec.body.applied);
  const myImports = await api(mona, '/api/marketplace/imports');
  const tplGrant = (myImports.body.grants ?? []).find((g) => g.approvalId === tpl.body.grant.approvalId);
  check('template grant now active', tplGrant?.status === 'active');

  // 8) Owner sees usage on the metric.
  console.log('\n8. Owner sees usage');
  const usage = await api(sara, `/api/marketplace/${revId}?as=sales`);
  const importerDomains = (usage.body.detail.importers ?? []).map((i) => i.domain);
  check('owner sees Marketing as an importer', importerDomains.includes('marketing'), JSON.stringify(importerDomains));

  // 9) Deprecate an in-use product → importers warned, grants kept.
  console.log('\n9. Lineage-aware deprecation warns importers');
  const dep = await api(sara, `/api/marketplace/${byName['Bank submission'].id}/deprecate`, { method: 'POST' });
  check('deprecated', dep.body.deprecated === true);
  check('Marketing warned (in-use, not silently removed)', (dep.body.warned ?? []).includes('marketing'), JSON.stringify(dep.body.warned));

  // 10) Own-domain product is not importable (already yours).
  console.log('\n10. Own-domain guard');
  const self = await api(mira, `/api/marketplace/${revId}/import`, { method: 'POST', body: JSON.stringify({ mode: 'read-grant', as: 'marketing' }) });
  // mira is marketing; Revenue is sales-owned, so this SHOULD succeed (idempotent w/ mona? different user) — instead test a sales user importing sales.
  const saraSelf = await api(sara, `/api/marketplace/${revId}/import`, { method: 'POST', body: JSON.stringify({ mode: 'read-grant', as: 'sales' }) });
  check('Sales cannot import its own product', saraSelf.status >= 400, `status ${saraSelf.status}`);
  void self;

  console.log(`\nRESULT: ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('gate error:', e.message);
  process.exit(2);
});
