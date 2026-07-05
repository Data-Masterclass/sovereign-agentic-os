/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Data Masterclass
 *
 * Offline validation of the Northpeak data seed — run with:
 *
 *   node --test seed/ecommerce-data/
 *
 * Proves, WITHOUT a cluster, that:
 *   1. every mart statement passes a byte-faithful mirror of the query-tool
 *      /execute guard (images/query-tool/execute_guard.py): allowlisted shape, no
 *      comments, single statement, and the target schema is authorized for the
 *      seed identity (builder in `northpeak`);
 *   2. statement order is dependency-safe (every referenced iceberg table is the
 *      base mart or an earlier target);
 *   3. physical names stay in LOCKSTEP with the platform (store-fqn slug():
 *      gold FQN == iceberg.<domain>.gold_<slug(name)> — what Cube/Explore/joins
 *      resolve);
 *   4. the registry narrative is closed over itself: measures aggregate documented
 *      columns, dashboards reference defined measures with correct Cube members,
 *      lineage upstreams name seeded datasets.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE_MART, COHORT_DOMAIN, DASHBOARDS, DATASETS, DOMAIN, GOLD_TABLES, GRANTS,
  INSTRUCTOR, martStatements,
} from './narrative.mjs';

// ------------------------------------------------- the guard, mirrored exactly --
// Port of execute_guard.py: _IDENT, the four statement shapes, comment/multi-
// statement rejection and the target authorization floor.
const IDENT = '[a-z_][a-z0-9_]*';
const RE_SCHEMA = new RegExp(`^create\\s+schema\\s+if\\s+not\\s+exists\\s+iceberg\\.(${IDENT})$`, 'i');
const RE_CTAS_REPLACE = new RegExp(`^create\\s+or\\s+replace\\s+table\\s+iceberg\\.(${IDENT})\\.(${IDENT})\\s+as\\s+select\\b[\\s\\S]*$`, 'i');
const RE_CTAS_IFNE = new RegExp(`^create\\s+table\\s+if\\s+not\\s+exists\\s+iceberg\\.(${IDENT})\\.(${IDENT})\\s+as\\s+select\\b[\\s\\S]*$`, 'i');
const RE_DROP = new RegExp(`^drop\\s+table\\s+if\\s+exists\\s+iceberg\\.(${IDENT})\\.(${IDENT})$`, 'i');

function guardParse(sql) {
  assert.ok(sql && sql.trim(), 'missing sql');
  let s = sql.trim();
  assert.ok(!s.includes('--') && !s.includes('/*') && !s.includes('*/'), `SQL comments not allowed: ${s.slice(0, 80)}`);
  if (s.endsWith(';')) s = s.slice(0, -1).trimEnd();
  assert.ok(!s.includes(';'), `multiple statements not allowed: ${s.slice(0, 80)}`);
  let m = s.match(RE_SCHEMA);
  if (m) return { kind: 'create_schema', schema: m[1], table: null };
  m = s.match(RE_CTAS_REPLACE) ?? s.match(RE_CTAS_IFNE);
  if (m) return { kind: 'ctas', schema: m[1], table: m[2] };
  m = s.match(RE_DROP);
  if (m) return { kind: 'drop_table', schema: m[1], table: m[2] };
  assert.fail(`statement off the /execute allowlist: ${s.slice(0, 120)}`);
}

function guardAuthorize(parsed, { uid, domains, role }) {
  if (domains.includes(parsed.schema)) {
    assert.ok(['builder', 'admin'].includes(role), `role '${role}' may not write to domain schema '${parsed.schema}'`);
    return;
  }
  const personal = 'personal_' + (uid.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'user');
  assert.equal(parsed.schema, personal, `schema '${parsed.schema}' is neither a domain nor the personal schema`);
}

/** Mirror of store-fqn slug() / metrics slug() — the naming lockstep contract. */
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'dataset';
/** Mirror of metrics cubeViewName() + measureMember() prefix. */
const memberPrefix = (name) => name.replace(/[^A-Za-z0-9]+/g, ' ').trim().replace(/\s+/g, '');

const SEED_IDENTITY = { uid: INSTRUCTOR.id, domains: [DOMAIN], role: INSTRUCTOR.role };

// ------------------------------------------------------------------- tests -----

test('every mart statement passes the /execute guard for the seed identity', () => {
  const stmts = martStatements();
  assert.ok(stmts.length >= 1 + DATASETS.length * 2, 'expected schema + per-dataset CTAS statements');
  for (const s of stmts) {
    const parsed = guardParse(s.sql);
    guardAuthorize(parsed, SEED_IDENTITY);
    assert.equal(parsed.schema, DOMAIN, `all writes target iceberg.${DOMAIN}`);
    if (parsed.kind === 'ctas') assert.equal(`iceberg.${parsed.schema}.${parsed.table}`, s.target);
  }
});

test('the probe statements marts.mjs runs also pass the guard', () => {
  for (const sql of [
    `create schema if not exists iceberg.${DOMAIN}`,
    `create or replace table iceberg.${DOMAIN}.seed_write_probe as select 1 as ok`,
    `drop table if exists iceberg.${DOMAIN}.seed_write_probe`,
  ]) guardAuthorize(guardParse(sql), SEED_IDENTITY);
});

test('statement order is dependency-safe (reads only the base mart or earlier targets)', () => {
  const created = new Set();
  for (const s of martStatements()) {
    if (s.kind !== 'ctas') continue;
    const refs = [...s.sql.matchAll(/iceberg\.[a-z0-9_]+\.[a-z0-9_]+/g)].map((m) => m[0]);
    for (const ref of refs) {
      if (ref === s.target) continue; // the create target itself
      assert.ok(
        ref === BASE_MART || created.has(ref),
        `${s.target} reads ${ref} before it exists`,
      );
    }
    created.add(s.target);
  }
});

test('physical names are in lockstep with store-fqn (assetTarget/versionTarget contract)', () => {
  for (const d of DATASETS) {
    assert.equal(d.slug, slug(d.name), `${d.name}: slug drifted`);
    const goldFqn = `iceberg.${DOMAIN}.gold_${slug(d.name)}`;
    assert.ok(GOLD_TABLES.includes(goldFqn), `${goldFqn} missing from GOLD_TABLES`);
    assert.ok(d.goldSql.includes(goldFqn), `${d.name}: goldSql does not create ${goldFqn}`);
  }
});

test('docs close over the gold schema: every measure aggregates a documented column', () => {
  for (const d of DATASETS) {
    assert.ok(d.description.length > 40, `${d.name}: description too thin for the transparency gate`);
    assert.ok(d.columns.length >= 8, `${d.name}: document the full gold schema`);
    const cols = new Set(d.columns.map((c) => c.name));
    for (const c of d.columns) assert.ok(c.description.trim(), `${d.name}.${c.name}: undocumented`);
    for (const m of d.measures) {
      if (m.aggregation === 'count') continue;
      assert.ok(cols.has(m.column), `${d.name}: measure '${m.name}' aggregates undocumented column '${m.column}'`);
    }
    // Each documented gold column must appear in the gold CTAS projection.
    for (const c of d.columns) assert.ok(d.goldSql.includes(c.name), `${d.name}: '${c.name}' not in goldSql`);
  }
});

test('lineage upstreams name seeded datasets (never dangling)', () => {
  const names = new Set(DATASETS.map((d) => d.name));
  for (const d of DATASETS) {
    for (const up of d.upstreams) assert.ok(names.has(up), `${d.name}: unknown upstream '${up}'`);
    assert.ok(!d.upstreams.includes(d.name), `${d.name}: self-upstream`);
  }
});

test('dashboards reference defined measures via correct Cube members', () => {
  for (const dash of DASHBOARDS) {
    const ds = DATASETS.find((d) => d.name === dash.dataset);
    assert.ok(ds, `${dash.name}: unknown dataset '${dash.dataset}'`);
    const prefix = memberPrefix(ds.name);
    const measures = new Set(ds.measures.map((m) => m.name));
    const columns = new Set(ds.columns.map((c) => c.name));
    assert.ok(dash.charts.length >= 3, `${dash.name}: needs >=3 charts`);
    for (const c of dash.charts) {
      const [view, member] = c.metric.split('.');
      assert.equal(view, prefix, `${dash.name} · ${c.name}: metric view '${view}' != '${prefix}'`);
      assert.ok(measures.has(member), `${dash.name} · ${c.name}: metric '${member}' is not a defined measure`);
      for (const dim of c.dimensions ?? []) {
        const [dv, dcol] = dim.split('.');
        assert.equal(dv, prefix, `${dash.name} · ${c.name}: dimension view drifted`);
        assert.ok(columns.has(dcol), `${dash.name} · ${c.name}: dimension '${dcol}' is not a documented column`);
      }
    }
  }
});

test('grants carry the cohort read path (domain + the domain-principal seam)', () => {
  const domains = GRANTS.filter((g) => g.grantee.kind === 'domain').map((g) => g.grantee.id);
  const users = GRANTS.filter((g) => g.grantee.kind === 'user').map((g) => g.grantee.id);
  assert.deepEqual(domains.sort(), [COHORT_DOMAIN, DOMAIN].sort());
  assert.ok(users.includes(COHORT_DOMAIN), 'the domain-principal seam grant is required for student /api/query reads');
  for (const g of GRANTS) assert.equal(g.action, 'read');
});

test('measure aggregations are valid Cube measure types', () => {
  const valid = new Set(['count', 'count_distinct', 'sum', 'avg', 'min', 'max', 'number']);
  for (const d of DATASETS) {
    for (const m of d.measures) {
      assert.ok(valid.has(m.aggregation), `${d.name}.${m.name}: bad aggregation '${m.aggregation}'`);
      assert.ok(/^[a-z][a-z0-9_]*$/.test(m.name), `${d.name}.${m.name}: measure names are lowercase idents`);
    }
  }
});
