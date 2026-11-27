/**
 * FEATURE:    Test of the app database module's configuration check.
 * USER STORY: As the author I want a clear error, not a hang, when the database is not set up.
 * ARCHITECTURE: Pure: passes an explicit environment; never opens a connection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, dbConfigured } from '../src/lib/db/index.ts';

test('the database counts as configured only with host, database and user', () => {
  assert.equal(dbConfigured({}), false);
  assert.equal(dbConfigured({ PGHOST: 'apps-pg-rw', PGDATABASE: 'app_x' }), false);
  assert.equal(dbConfigured({ PGHOST: 'apps-pg-rw', PGDATABASE: 'app_x', PGUSER: 'app_x' }), true);
});

test('without configuration db() refuses with a reason instead of connecting', () => {
  assert.throws(() => db({}), /not configured/);
});
