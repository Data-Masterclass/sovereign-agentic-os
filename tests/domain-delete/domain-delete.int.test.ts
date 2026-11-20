/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Delete domain against REAL components: Trino + Polaris (+ MinIO), OPA, OpenSearch
 *             (the OS stores' durable mirror), LiteLLM (with its Postgres)
 * USER STORY: As the admin deleting a domain I want proof from the components themselves that
 *             the domain is gone — tables dropped AND their files purged, policy keys deleted,
 *             gateway team and keys deleted, records gone — while the other domain, including a
 *             legacy lane table it shares through an ARCHIVED dataset, is byte-identical.
 * ARCHITECTURE:
 *   - Harness: tests/domain-delete/up.sh (the chart's Trino/Polaris/OPA/MinIO from the lakehouse
 *     render, OpenSearch, LiteLLM). Run from os-ui with the env up.sh writes. Fails, never skips,
 *     when DD_IT=1 and a component is missing.
 *   - The component list is the one that ships (`domain-delete-sources.ts`); only the Trino
 *     transport is the direct client instead of the query-tool (same statements, same identity).
 *   - Two domains K and O. Fixture: K's legacy-lane asset, K's `service_centers` whose legacy lane
 *     tables are ALSO O's ARCHIVED dataset's tables (must be KEPT), K's archived dataset with an
 *     orphaned gold table, a sole member's personal dataset plus a table no dataset maps to, O's
 *     domain-schema table, OPA keys for both, LiteLLM teams + keys for both, folders, dashboards.
 *   - Negative twins: the dry run removes nothing; a run without confirmation removes nothing; the
 *     KEEP set is asserted by name; and the purge proof would fail if Polaris kept the files.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-ignore -- the harness client is plain JS
import { run } from '../lakehouse/lib.mjs';

const on = process.env.DD_IT === '1';
const skip = on ? false : 'DD_IT not set (start tests/domain-delete/up.sh and export its test.env)';
process.env.OS_REPOS_DIR ??= mkdtempSync(join(tmpdir(), 'dd-repos-'));

const sfx = Date.now().toString(36);
const K = `kiekert-${sfx}`;
const O = `other-${sfx}`;
const KS = K.replace(/-/g, '_');
const OS = O.replace(/-/g, '_');
const ADMIN = `it_admin_${sfx}`;
const JONAS = `it_jonas_${sfx}`;
const TOBIAS = `it_tobias_${sfx}`;
const OSURL = process.env.OPENSEARCH_URL ?? '';
const OPA = process.env.OPA_URL ?? '';
const LLM = process.env.LITELLM_URL ?? '';
const MK = process.env.LITELLM_MASTER_KEY ?? '';

// Fixture setup and read-back go to Trino directly; the DELETE itself goes through the shipped
// door — the governed query-tool (`QUERY_TOOL_URL`), exactly as production does.
const trino = (sql: string, user: string): Promise<{ rows: unknown[][] }> => run(sql, { user, source: 'domain-delete-it' });

async function http(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
const llm = (path: string, body?: unknown) => http(body === undefined ? 'GET' : 'POST', `${LLM}${path}`, body, { authorization: `Bearer ${MK}` });

/** Every OpenSearch doc that names O and not K — the other domain's state, byte for byte. Member
 *  records are left out: shared members lose K by design, which the test asserts on its own. */
async function otherDomainDocs(): Promise<Record<string, string>> {
  await http('POST', `${OSURL}/_refresh`);
  const idx = (await http('GET', `${OSURL}/_cat/indices?format=json`)).json as { index: string }[];
  const out: Record<string, string> = {};
  for (const { index } of idx) {
    if (index.startsWith('.') || index === 'os-users') continue;
    const r = await http('POST', `${OSURL}/${index}/_search`, { size: 2000, query: { match_all: {} } });
    for (const h of r.json.hits.hits as { _id: string; _source: unknown }[]) {
      const s = JSON.stringify(h._source);
      if (s.includes(O) && !s.includes(K)) out[`${index}/${h._id}`] = createHash('sha256').update(s).digest('hex');
    }
  }
  return out;
}

async function kDocs(): Promise<string[]> {
  await http('POST', `${OSURL}/_refresh`);
  const idx = (await http('GET', `${OSURL}/_cat/indices?format=json`)).json as { index: string }[];
  const out: string[] = [];
  for (const { index } of idx) {
    if (index.startsWith('.') || index === 'os-audit') continue;
    const r = await http('POST', `${OSURL}/${index}/_search`, { size: 2000, query: { match_all: {} } });
    for (const h of r.json.hits.hits as { _id: string; _source: unknown }[]) {
      const s = JSON.stringify(h._source);
      if (s.includes(`"${K}"`) || s.includes(`domain: ${K}`)) out.push(`${index}/${h._id}`);
    }
  }
  return out;
}

/** MinIO: does any object live under this Iceberg table's prefix? (S3 ListObjectsV2, SigV4.) */
async function s3Count(prefix: string): Promise<number> {
  const host = new URL(process.env.DD_S3_URL!).host;
  const key = process.env.DD_S3_KEY!, secret = process.env.DD_S3_SECRET!;
  const now = new Date();
  const amz = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amz.slice(0, 8);
  const qs = `list-type=2&prefix=${encodeURIComponent(prefix)}`;
  const ph = createHash('sha256').update('').digest('hex');
  const canon = `GET\n/lakehouse\n${qs}\nhost:${host}\nx-amz-content-sha256:${ph}\nx-amz-date:${amz}\n\nhost;x-amz-content-sha256;x-amz-date\n${ph}`;
  const scope = `${date}/us-east-1/s3/aws4_request`;
  const sts = `AWS4-HMAC-SHA256\n${amz}\n${scope}\n${createHash('sha256').update(canon).digest('hex')}`;
  const h = (k: Buffer | string, d: string) => createHmac('sha256', k).update(d).digest();
  const sig = createHmac('sha256', h(h(h(h(`AWS4${secret}`, date), 'us-east-1'), 's3'), 'aws4_request')).update(sts).digest('hex');
  const res = await fetch(`${process.env.DD_S3_URL}/lakehouse?${qs}`, { headers: { 'x-amz-date': amz, 'x-amz-content-sha256': ph, authorization: `AWS4-HMAC-SHA256 Credential=${key}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${sig}` } });
  const xml = await res.text();
  if (!res.ok) throw new Error(`S3 list ${res.status}: ${xml.slice(0, 200)}`);
  return (xml.match(/<Key>/g) ?? []).length;
}
async function tableLocation(fqn: string, user: string): Promise<string> {
  const [, s, t] = fqn.split('.');
  const r = await trino(`SELECT file_path FROM iceberg.${s}."${t}$files" LIMIT 1`, user);
  const p = String(r.rows[0][0]);
  return p.replace('s3://lakehouse/', '').replace(/\/data\/.*$/, '/');
}

const tablesOf = async (schema: string, user: string) =>
  (await trino(`SELECT table_name FROM iceberg.information_schema.tables WHERE table_schema = '${schema}' ORDER BY 1`, user)).rows.map((r) => String(r[0]));
const rowsOf = async (fqn: string, user: string) => JSON.stringify((await trino(`SELECT * FROM ${fqn} ORDER BY 1, 2`, user)).rows);

let sources: typeof import('../../os-ui/domain-delete-sources');
let engine: typeof import('../../os-ui/core/kernel/domain-delete');

before(async () => {
  if (skip) return;
  for (const [name, v] of Object.entries({ OPENSEARCH_URL: OSURL, OPA_URL: OPA, LITELLM_URL: LLM, LH_TRINO_URL: process.env.LH_TRINO_URL, QUERY_TOOL_URL: process.env.QUERY_TOOL_URL })) {
    assert.ok(v, `${name} must be set when DD_IT=1`);
  }
  engine = await import('@core/kernel/domain-delete');
  sources = await import('@/domain-delete-sources');
  const users = await import('@tabs/admin/lib/users');
  const domains = await import('@tabs/admin/lib/domains');
  const data = await import('@tabs/data/lib/store');
  const folders = await import('@core/folders/folder-store');

  // Members: the admin in both, Jonas only in K (sole member), Tobias in both.
  await users.createUser({ id: ADMIN, password: 'It-Admin-Passw0rd!x', domains: [K, O], role: 'admin', email: `${ADMIN}@example.org` });
  await users.createUser({ id: JONAS, password: 'It-Jonas-Passw0rd!x', domains: [K], role: 'domain_admin', email: `${JONAS}@example.org` });
  await users.createUser({ id: TOBIAS, password: 'It-Tobias-Passw0rd!x', domains: [O, K], role: 'builder', email: `${TOBIAS}@example.org` });
  domains.createDomain({ name: K, owner: ADMIN });
  domains.createDomain({ name: O, owner: ADMIN });
  const admin = { id: ADMIN, role: 'admin' as const, domains: [K, O] };
  const jonas = { id: JONAS, role: 'domain_admin' as const, domains: [K] };

  // Datasets (legacy lane names: no laneSlug, exactly prod's 0.9.23 records).
  data.__seedDatasetForTest({ id: `ds_k1_${sfx}`, name: 'Teile', owner: ADMIN, domain: K, tier: 'asset' });
  data.__seedDatasetForTest({ id: `ds_k2_${sfx}`, name: 'service_centers', owner: ADMIN, domain: K, tier: 'asset' });
  data.__seedDatasetForTest({ id: `ds_k3_${sfx}`, name: 'Archived Teil', owner: ADMIN, domain: K, tier: 'asset' });
  data.archiveDataset(`ds_k3_${sfx}`, admin);
  data.__seedDatasetForTest({ id: `ds_k4_${sfx}`, name: 'Test', owner: JONAS, domain: K, tier: 'dataset' });
  data.__seedDatasetForTest({ id: `ds_o1_${sfx}`, name: 'service_centers', owner: ADMIN, domain: O, tier: 'asset' });
  data.archiveDataset(`ds_o1_${sfx}`, admin); // ARCHIVED sibling: still protects the shared lane

  folders.createFolder(admin, { tab: 'data', scope: 'domain', path: '/Einkauf', domain: K });
  folders.createFolder(admin, { tab: 'data', scope: 'domain', path: '/Keep', domain: O });

  // Iceberg, through Trino (Polaris catalog, MinIO storage).
  const pa = `personal_${ADMIN}`, pj = `personal_${JONAS}`;
  await trino(`CREATE SCHEMA IF NOT EXISTS iceberg.${pa}`, ADMIN);
  await trino(`CREATE SCHEMA IF NOT EXISTS iceberg.${pj}`, JONAS);
  await trino(`CREATE SCHEMA IF NOT EXISTS iceberg.${KS}`, K);
  await trino(`CREATE SCHEMA IF NOT EXISTS iceberg.${OS}`, O);
  const ctas = (fqn: string, user: string, tag: string) => trino(`CREATE TABLE ${fqn} AS SELECT * FROM (VALUES ('${tag}', 1), ('${tag}', 2)) t(src, n)`, user);
  for (const l of ['bronze', 'silver', 'gold']) {
    await ctas(`iceberg.${pa}.${l}_teile`, ADMIN, 'k1');
    await ctas(`iceberg.${pa}.${l}_service_centers`, ADMIN, 'shared');
  }
  await ctas(`iceberg.${KS}.gold_teile`, K, 'k1-domain');
  await ctas(`iceberg.${pa}.gold_archived_teil`, ADMIN, 'orphan'); // built=false on the record
  await ctas(`iceberg.${pj}.bronze_test`, JONAS, 'jonas');
  await ctas(`iceberg.${pj}.bronze_test2`, JONAS, 'jonas-orphan'); // no dataset maps to it
  await ctas(`iceberg.${OS}.gold_service_centers`, O, 'o-domain');
  await ctas(`iceberg.${pa}.gold_unrelated_${sfx}`, ADMIN, 'admin-other-work'); // not K's: untouched

  // OPA governance data for both domains.
  const put = (p: string, v: unknown) => http('PUT', `${OPA}/v1/data/${p}`, v);
  await put(`governance/tables/${encodeURIComponent(`iceberg.${KS}.gold_teile`)}`, { domain: K });
  await put(`governance/tables/${encodeURIComponent(`iceberg.${OS}.gold_service_centers`)}`, { domain: O });
  await put(`governance/principals/${encodeURIComponent(K)}`, { domains: [K], clearances: [] });
  await put(`governance/principals/${encodeURIComponent(O)}`, { domains: [O], clearances: [] });
  await put(`governance/principals/${encodeURIComponent(JONAS)}`, { domains: [K], clearances: [] });
  await put(`governance/principals/${encodeURIComponent(TOBIAS)}`, { domains: [O, K], clearances: [] });

  // LiteLLM teams and keys for both.
  const tk = (await llm('/team/new', { team_alias: K })).json.team_id;
  const to = (await llm('/team/new', { team_alias: O })).json.team_id;
  await llm('/key/generate', { key_alias: `k-key-${sfx}`, team_id: tk });
  await llm('/key/generate', { key_alias: `o-key-${sfx}`, team_id: to });
  await new Promise((r) => setTimeout(r, 1500)); // fire-and-forget mirror writes land
});

// No Dagster in this harness: the git component BLOCKS a repo then (K has none). Dagster is proven
// in images/extensions/dagster/tests/image/domain-prune.sh against the real image.
const components = () => sources.domainDeleteComponents({ git: { dagster: null } });
const adminActor = () => ({ id: ADMIN, role: 'admin' as const, domains: [K, O] });
const audit: { action: string; target: string; result: string; detail: string }[] = [];
const deps = () => ({
  actor: adminActor(),
  components: components(),
  audit: (e: (typeof audit)[number]) => { audit.push(e); },
  backup: async () => ({ ok: false as const, reason: 'no Velero in the harness' }),
  validateTarget: async (id: string) => (await import('@tabs/admin/lib/domain-delete')).assertDeletableDomain(id),
  // The shipped preflight against the REAL query-tool: it must advertise `domain-delete`.
  preflight: () => sources.queryToolPreflight(),
  allowRun: true,
});

let before_: { docs: Record<string, string>; o: string; shared: Record<string, string>; opa: string; team: string };

test('dry run (the default) plans every component, KEEPS the shared legacy lane, removes nothing', { skip }, async () => {
  before_ = {
    docs: await otherDomainDocs(),
    o: await rowsOf(`iceberg.${OS}.gold_service_centers`, O),
    shared: Object.fromEntries(await Promise.all(['bronze', 'silver', 'gold'].map(async (l) => [l, await rowsOf(`iceberg.personal_${ADMIN}.${l}_service_centers`, ADMIN)]))),
    opa: JSON.stringify([(await http('GET', `${OPA}/v1/data/governance/tables/${encodeURIComponent(`iceberg.${OS}.gold_service_centers`)}`)).json.result, (await http('GET', `${OPA}/v1/data/governance/principals/${encodeURIComponent(O)}`)).json.result]),
    team: JSON.stringify(((await llm('/team/list')).json as { team_alias: string; team_id: string }[]).filter((t) => t.team_alias === O).map((t) => t.team_id)),
  };
  assert.ok(Object.keys(before_.docs).length > 0, 'the other domain has mirrored state to compare');
  const r = await engine.deleteDomain(K, {}, deps());
  assert.equal(r.status, 'planned');
  const by = Object.fromEntries(r.plan.components.map((p) => [p.component, p]));
  const trinoRemove = by.trino.remove.map((i) => i.label).sort();
  const pa = `iceberg.personal_${ADMIN}`;
  assert.deepEqual(trinoRemove, [
    ...['bronze', 'silver', 'gold'].map((l) => `${pa}.${l}_teile`), `${pa}.gold_archived_teil`,
    `iceberg.${KS}`, `iceberg.${KS}.gold_teile`,
    `iceberg.personal_${JONAS}`, `iceberg.personal_${JONAS}.bronze_test`, `iceberg.personal_${JONAS}.bronze_test2`,
  ].sort());
  const mapped = by.trino.keep.filter((k) => k.reason.startsWith('still mapped by'));
  assert.deepEqual(mapped.map((k) => k.label).sort(), ['bronze', 'gold', 'silver'].map((l) => `${pa}.${l}_service_centers`));
  assert.ok(mapped.every((k) => k.reason.includes(`ds_o1_${sfx}`) && k.reason.includes('archived')));
  // the admin's other work in their personal schema is LISTED as kept, never silently skipped
  assert.ok(by.trino.keep.some((k) => k.label === `${pa}.gold_unrelated_${sfx}` && /keeps other domains/.test(k.reason)));
  assert.ok(!by.trino.remove.concat(by.trino.keep).some((i) => i.label.includes(`iceberg.${OS}.`)), "the other domain's schema is never inspected");
  assert.equal(by['os.datasets'].remove.length, 4);
  assert.equal(by['os.folders'].remove.length, 1);
  assert.deepEqual(by.opa.remove.map((i) => `${i.kind}:${i.id}`).sort(), [`governance-principal-domain:${TOBIAS}`, `governance-principal:${JONAS}`, `governance-principal:${K}`, `governance-table:iceberg.${KS}.gold_teile`].sort());
  assert.deepEqual(by.litellm.remove.map((i) => i.kind).sort(), ['key', 'team']);
  assert.deepEqual(by.users.remove.map((i) => `${i.kind}:${i.id}`).sort(), [`deactivate:${JONAS}`, `membership:${ADMIN}`, `membership:${TOBIAS}`].sort());
  assert.equal(by.domain.remove.length, 1);
  // negative twin: nothing was touched
  assert.equal((await tablesOf(`personal_${JONAS}`, JONAS)).length, 2);
  assert.equal(((await llm('/team/list')).json as { team_alias: string }[]).filter((t) => t.team_alias === K).length, 1);
});

test('the target must be a registered, non-reserved domain that is not a user id', { skip }, async () => {
  for (const bad of ['platform', `user-${sfx}`, `nope-${sfx}`, ADMIN.replace(/_/g, '-')]) {
    await assert.rejects(engine.deleteDomain(bad, {}, deps()), /reserved|not a registered|not a domain id|user id/, bad);
  }
  const users = await import('@tabs/admin/lib/users');
  const domains = await import('@tabs/admin/lib/domains');
  domains.createDomain({ name: TOBIAS.replace(/_/g, '-'), owner: ADMIN });
  await users.createUser({ id: TOBIAS.replace(/_/g, '-'), password: 'It-Twin-Passw0rd!x', domains: [O], role: 'creator', email: `twin-${sfx}@example.org` });
  await assert.rejects(engine.deleteDomain(TOBIAS.replace(/_/g, '-'), {}, deps()), /user id/);
  await domains.removeDomain(TOBIAS.replace(/_/g, '-'));
});

test('an admin whose only domain is the deleted one is never deactivated: the run is refused', { skip }, async () => {
  const users = await import('@tabs/admin/lib/users');
  const ADMIN2 = `it_admin2_${sfx}`;
  await users.createUser({ id: ADMIN2, password: 'It-Admin2-Passw0rd!x', domains: [K], role: 'admin', email: `${ADMIN2}@example.org` });
  const r = await engine.deleteDomain(K, { dryRun: false, confirm: K, iHaveABackup: true }, deps());
  assert.equal(r.status, 'refused');
  const users_ = r.plan.components.find((c) => c.component === 'users')!;
  assert.ok((users_.blocked ?? []).some((b) => b.id === ADMIN2 && /admin/.test(b.reason)));
  assert.ok((await tablesOf(KS, K)).includes('gold_teile'), 'nothing was removed');
  // a person resolves it (the admin gets another domain); the delete then proceeds in the next test
  await users.updateUser(ADMIN2, { domains: [O, K] });
});

test('the MCP door may only plan: a run through it is refused', { skip }, async () => {
  await assert.rejects(engine.deleteDomain(K, { dryRun: false, confirm: K, iHaveABackup: true }, { ...deps(), allowRun: false }), /may only plan/);
  assert.ok((await tablesOf(KS, K)).includes('gold_teile'));
});

test('the query-tool refuses DROP SCHEMA outside the governed delete (twin of the path the run uses)', { skip }, async () => {
  const gov = await import('@core/infra/governed');
  const id = { principal: JONAS, uid: JONAS, domains: [K], role: 'admin' as const };
  await assert.rejects(gov.executeRun(`DROP SCHEMA IF EXISTS iceberg.personal_${JONAS}`, id, gov.executeRoute(id, 'it')), /only for the governed delete-domain run/);
  await assert.rejects(gov.executeRun(`DROP SCHEMA IF EXISTS iceberg.personal_${JONAS}`, { ...id, role: 'domain_admin' }, gov.executeRoute(id, 'it'), undefined, 15000, 'domain-delete'), /admin role/);
  assert.equal((await tablesOf(`personal_${JONAS}`, JONAS)).length, 2, 'the schema is still there');
});

test('a run is refused without the typed id, then without a backup; nothing is removed', { skip }, async () => {
  const r1 = await engine.deleteDomain(K, { dryRun: false, confirm: 'nope' }, deps());
  assert.equal(r1.status, 'refused');
  const r2 = await engine.deleteDomain(K, { dryRun: false, confirm: K }, deps());
  assert.equal(r2.status, 'refused');
  assert.match((r2 as { reason: string }).reason, /backup/);
  assert.ok((await tablesOf(KS, K)).includes('gold_teile'));
});

test('the run removes the domain through each component; the other domain is byte-identical', { skip }, async () => {
  const locs = {
    teile: await tableLocation(`iceberg.personal_${ADMIN}.gold_teile`, ADMIN),
    jonas: await tableLocation(`iceberg.personal_${JONAS}.bronze_test2`, JONAS),
    shared: await tableLocation(`iceberg.personal_${ADMIN}.gold_service_centers`, ADMIN),
  };
  assert.ok((await s3Count(locs.teile)) > 0, 'files exist before');
  const r = await engine.deleteDomain(K, { dryRun: false, confirm: K, iHaveABackup: true }, deps());
  assert.equal(r.status, 'done', JSON.stringify((r as { failed?: unknown }).failed ?? r.status));

  // Trino + Polaris: K's tables and schemas are gone, and Polaris purged their files.
  assert.deepEqual(await tablesOf(KS, K), []);
  assert.equal((await trino(`SELECT schema_name FROM iceberg.information_schema.schemata WHERE schema_name IN ('${KS}', 'personal_${JONAS}')`, ADMIN)).rows.length, 0);
  assert.deepEqual((await tablesOf(`personal_${ADMIN}`, ADMIN)).filter((t) => /teile|archived_teil/.test(t)), []);
  let purged = false;
  for (let i = 0; i < 30 && !purged; i++) {
    purged = (await s3Count(locs.teile)) === 0 && (await s3Count(locs.jonas)) === 0;
    if (!purged) await new Promise((res) => setTimeout(res, 1000));
  }
  assert.ok(purged, 'Polaris deleted the dropped tables\' data and metadata files');

  // KEPT: the shared legacy lane, its files, and everything of O — byte for byte.
  for (const l of ['bronze', 'silver', 'gold']) assert.equal(await rowsOf(`iceberg.personal_${ADMIN}.${l}_service_centers`, ADMIN), before_.shared[l]);
  assert.ok((await s3Count(locs.shared)) > 0);
  assert.equal(await rowsOf(`iceberg.${OS}.gold_service_centers`, O), before_.o);
  assert.ok((await tablesOf(`personal_${ADMIN}`, ADMIN)).includes(`gold_unrelated_${sfx}`), "the admin's other work is untouched");
  assert.equal(JSON.stringify([(await http('GET', `${OPA}/v1/data/governance/tables/${encodeURIComponent(`iceberg.${OS}.gold_service_centers`)}`)).json.result, (await http('GET', `${OPA}/v1/data/governance/principals/${encodeURIComponent(O)}`)).json.result]), before_.opa);
  assert.equal(JSON.stringify(((await llm('/team/list')).json as { team_alias: string; team_id: string }[]).filter((t) => t.team_alias === O).map((t) => t.team_id)), before_.team);
  await new Promise((res) => setTimeout(res, 1500));
  assert.deepEqual(await otherDomainDocs(), before_.docs, 'every OpenSearch doc of the other domain is byte-identical');

  // OPA: K's keys gone; Tobias keeps his principal without K.
  assert.equal((await http('GET', `${OPA}/v1/data/governance/tables/${encodeURIComponent(`iceberg.${KS}.gold_teile`)}`)).json.result, undefined);
  assert.equal((await http('GET', `${OPA}/v1/data/governance/principals/${encodeURIComponent(JONAS)}`)).json.result, undefined);
  assert.deepEqual((await http('GET', `${OPA}/v1/data/governance/principals/${encodeURIComponent(TOBIAS)}`)).json.result.domains, [O]);
  // LiteLLM: K's team and its key gone, O's key kept.
  assert.equal(((await llm('/team/list')).json as { team_alias: string }[]).filter((t) => t.team_alias === K).length, 0);
  const keys = (await llm('/key/list?return_full_object=true')).json.keys as { key_alias: string }[];
  assert.ok(!keys.some((k) => k.key_alias === `k-key-${sfx}`));
  assert.ok(keys.some((k) => k.key_alias === `o-key-${sfx}`));
  // Stores: nothing in OpenSearch names K any more (the audit history is kept).
  assert.deepEqual(await kDocs(), []);
  // Members: Jonas archived; nobody lists K.
  const users = await import('@tabs/admin/lib/users');
  const all = await users.listUsers();
  assert.equal(all.find((u) => u.id === JONAS)?.disabled, true);
  assert.ok(all.every((u) => !u.domains.includes(K)));
  assert.deepEqual(all.find((u) => u.id === `it_admin2_${sfx}`)?.disabled ?? false, false, 'an admin is never deactivated');
  // Every step audited, and the run ended ok.
  const steps = audit.filter((e) => e.action === 'domain.delete.step');
  assert.equal(steps.length, r.status === 'done' ? r.done.length : -1);
  assert.equal(audit.at(-1)!.action, 'domain.delete');
  assert.equal(audit.at(-1)!.result, 'ok');
});

test('a finished delete: the domain is gone (refused as unregistered) and nothing is left to plan', { skip }, async () => {
  await assert.rejects(engine.deleteDomain(K, {}, deps()), /not a registered domain/);
  const r = await engine.deleteDomain(K, {}, { ...deps(), validateTarget: undefined });
  assert.equal(r.plan.totals.remove, 0, engine.planLines(r.plan).join('\n'));
});

test('a Data-tab DROP (the iceberg catalog) cannot purge; the twin through the purge catalog does', { skip }, async () => {
  const gov = await import('@core/infra/governed');
  const pa = `personal_${ADMIN}`;
  await trino(`CREATE TABLE iceberg.${pa}.purge_probe AS SELECT * FROM (VALUES (1)) t(n)`, ADMIN);
  const loc = await tableLocation(`iceberg.${pa}.purge_probe`, ADMIN);
  const id = { principal: ADMIN, uid: ADMIN, domains: [O], role: 'admin' as const };
  // The Data-tab door: the governed DROP on `iceberg`. Polaris refuses the purge (403).
  await assert.rejects(gov.executeRun(`DROP TABLE IF EXISTS iceberg.${pa}.purge_probe`, id, gov.executeRoute(id, 'data-delete')));
  assert.ok((await tablesOf(pa, ADMIN)).includes('purge_probe'), 'the table stays');
  assert.ok((await s3Count(loc)) > 0, 'and its files stay');
  // Nobody but the purge user may use the purge catalog, not even an admin directly on Trino.
  await assert.rejects(trino(`SELECT count(*) FROM iceberg_purge.${pa}.purge_probe`, ADMIN), /denied|Access/i);
  // Twin: the delete-domain door (purpose + admin) on the purge catalog drops AND purges.
  await gov.executeRun(`DROP TABLE IF EXISTS iceberg_purge.${pa}.purge_probe`, id, gov.executeRoute(id, 'domain-delete'), undefined, 60_000, 'domain-delete');
  assert.ok(!(await tablesOf(pa, ADMIN)).includes('purge_probe'));
  let n = 1;
  for (let i = 0; i < 30 && n > 0; i++) { n = await s3Count(loc); if (n) await new Promise((r) => setTimeout(r, 1000)); }
  assert.equal(n, 0, 'Polaris purged the files');
});
