/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPbids, pbidsToString, pbidsFilename, type PbidsFile } from './pbids.ts';

// ── Shape ─────────────────────────────────────────────────────────────────────

test('buildPbids: produces the correct .pbids JSON shape', () => {
  const pbids = buildPbids('sales', 'cube-sql.example.com', 15432);
  assert.equal(pbids.version, '0.1');
  assert.equal(pbids.connections.length, 1);
  const conn = pbids.connections[0];
  assert.equal(conn.details.protocol, 'postgresql');
  assert.equal(conn.details.address.server, 'cube-sql.example.com:15432');
  assert.equal(conn.details.address.database, 'bi_sales');
  assert.equal(conn.options.mode, 'DirectQuery');
  assert.equal(conn.mode, 'DirectQuery');
});

// ── RLS via DirectQuery ───────────────────────────────────────────────────────

test('buildPbids: mode is always DirectQuery — never Import (RLS invariant)', () => {
  const pbids = buildPbids('finance', 'cube-sql.example.com', 15432);
  // Both the options and the top-level mode must be DirectQuery.
  // Import mode would snapshot rows and bypass Cube's checkSqlAuth on every query.
  for (const conn of pbids.connections) {
    assert.equal(conn.mode, 'DirectQuery', 'top-level mode must be DirectQuery');
    assert.equal(conn.options.mode, 'DirectQuery', 'options.mode must be DirectQuery');
  }
});

// ── Password invariant ────────────────────────────────────────────────────────

test('buildPbids: NO password anywhere in the serialised output', () => {
  const pbids = buildPbids('sales', 'cube-sql.example.com', 15432);
  const raw = pbidsToString(pbids);
  // The word "password" must not appear in any form — neither as a key nor a value.
  assert.doesNotMatch(raw, /password/i, '.pbids must never contain a password field');
  // The word "credential" must also be absent.
  assert.doesNotMatch(raw, /credential/i, '.pbids must never contain a credentials field');
  // Sanity: the file IS valid JSON
  const parsed = JSON.parse(raw) as PbidsFile;
  assert.equal(parsed.version, '0.1');
});

// ── Per-domain isolation ──────────────────────────────────────────────────────

test('buildPbids: different domains produce different principals — no cross-domain bleed', () => {
  const sales = buildPbids('sales', 'cube-sql.example.com', 15432);
  const finance = buildPbids('finance', 'cube-sql.example.com', 15432);
  const salesDb = sales.connections[0].details.address.database;
  const financeDb = finance.connections[0].details.address.database;
  assert.equal(salesDb, 'bi_sales');
  assert.equal(financeDb, 'bi_finance');
  assert.notEqual(salesDb, financeDb, 'domains must produce distinct database/user values');
});

// ── Host + port ───────────────────────────────────────────────────────────────

test('buildPbids: server field is host:port', () => {
  const pbids = buildPbids('sales', 'bi.internal.example.com', 5433);
  assert.equal(pbids.connections[0].details.address.server, 'bi.internal.example.com:5433');
});

// ── Input validation ─────────────────────────────────────────────────────────

test('buildPbids: rejects invalid/empty domain (inherits from biUserForDomain)', () => {
  assert.throws(() => buildPbids('', 'host', 15432), /invalid|empty/i);
  assert.throws(() => buildPbids('   ', 'host', 15432), /invalid|empty/i);
  assert.throws(() => buildPbids('!!!', 'host', 15432), /invalid|empty/i);
});

// ── Filename ──────────────────────────────────────────────────────────────────

test('pbidsFilename: produces the expected download name', () => {
  assert.equal(pbidsFilename('sales'), 'sovereign-os-bi_sales.pbids');
  assert.equal(pbidsFilename('Sales Ops'), 'sovereign-os-bi_sales_ops.pbids');
});

// ── Serialisation ─────────────────────────────────────────────────────────────

test('pbidsToString: produces valid, parseable JSON', () => {
  const pbids = buildPbids('sales', 'cube-sql.example.com', 15432);
  const str = pbidsToString(pbids);
  assert.ok(typeof str === 'string' && str.length > 0);
  // Must round-trip cleanly
  const roundtrip = JSON.parse(str) as PbidsFile;
  assert.deepEqual(roundtrip, pbids);
});
