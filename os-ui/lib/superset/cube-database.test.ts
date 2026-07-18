/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CUBE_SQL_PASSWORD_PLACEHOLDER, cubeDatabaseName, cubeSqlDatabase } from './cube-database.ts';

test('cubeSqlDatabase builds a Cube SQL connection as the bi_<domain> principal', () => {
  const db = cubeSqlDatabase('sales');
  assert.equal(db.service_name, 'cube_sales');
  assert.equal(db.cube_sql, true);
  assert.equal(db.sqlalchemy_uri, `postgresql://bi_sales:${CUBE_SQL_PASSWORD_PLACEHOLDER}@cube-sql:15432/bi_sales`);
});

test('a hyphenated domain normalizes to a valid postgres identifier (matches checkSqlAuth)', () => {
  // The live gold table lives in schema `agentic_leader_q3_2026`; the domain id is
  // `agentic-leader-q3-2026`. The BI principal MUST normalize identically so Cube's
  // checkSqlAuth maps the username back to the same domain scope.
  const db = cubeSqlDatabase('agentic-leader-q3-2026');
  assert.equal(cubeDatabaseName('agentic-leader-q3-2026'), 'cube_agentic_leader_q3_2026');
  assert.match(db.sqlalchemy_uri, /^postgresql:\/\/bi_agentic_leader_q3_2026:.*@cube-sql:15432\/bi_agentic_leader_q3_2026$/);
});

test('operator host/port override is honoured', () => {
  const db = cubeSqlDatabase('sales', { host: 'cube.example.com', port: 25432 });
  assert.match(db.sqlalchemy_uri, /@cube\.example\.com:25432\//);
});

test('never embeds a real password — only the placeholder', () => {
  const db = cubeSqlDatabase('sales');
  assert.ok(db.sqlalchemy_uri.includes(CUBE_SQL_PASSWORD_PLACEHOLDER));
});

test('an empty/invalid domain throws (never mint an unscoped principal)', () => {
  assert.throws(() => cubeSqlDatabase(''), /empty\/invalid domain/);
});
