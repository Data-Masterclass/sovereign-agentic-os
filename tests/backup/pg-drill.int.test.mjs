/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * WP-56 — the Postgres restore drill against a REAL Postgres 17 (the chart's postgres image) and
 * SeaweedFS, running the RENDERED `pg-fetch` and `pg-drill` initContainers (command, env, uid,
 * read-only root, EMPTY /work and /tmp). The dump is made with the SAME commands and layout as the
 * chart's pg-dump CronJob (pg_dumpall --globals-only, pg_dump -Fc per database, MANIFEST,
 * s3://<bucket>/<prefix>/<UTC-stamp>/). The drill restores into a SCRATCH server inside its own
 * container and compares with the live server read-only.
 *
 * Negative twins: no run, a stale run, a corrupted dump, a database with no table, a table whose
 * restored row count is far from live, a database missing from the dump. And: the downloaded
 * dumps (role password hashes included) are gone the moment the check ends.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tools, PG_IMAGE, PGDUMP, P, WORK } from './harness.mjs';
import { runRendered, emptyDir } from './rendered.mjs';

const PREFIX = 't-pg';
const live = `export PGHOST=pg PGUSER=postgres PGPASSWORD=ci-only`;
const S3ENV = Object.fromEntries(readFileSync(join(WORK, 's3.env'), 'utf8').trim().split('\n').map((l) => l.split('=')));
const psql = (sql) => {
  const r = tools(`set -e; ${live}; ${sql}`, {}, { image: PG_IMAGE, user: '999:999' });
  assert.equal(r.code, 0, r.log);
};
const stamp = (hoursAgo = 0) => new Date(Date.now() - hoursAgo * 3600e3).toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');

function cleanBucket() {
  const r = tools(`aws --endpoint-url "$S3_ENDPOINT" s3 rm --recursive --quiet s3://${PGDUMP}/${PREFIX}/`, { S3_BUCKET: PGDUMP });
  assert.equal(r.code, 0, r.log);
}

function dumpRun(dir, st, { corrupt = false } = {}) {
  const out = emptyDir(join(WORK, dir));
  // Same commands as templates/extensions/backup/pg-dump-cronjob.yaml (init container `dump`).
  let r = tools(`set -e; ${live}; OUT=/work/${dir}
    DBS=$(psql -d postgres -Atc "SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres' ORDER BY 1")
    pg_dumpall --globals-only > "$OUT/globals.sql"
    for db in $DBS; do pg_dump -Fc -d "$db" -f "$OUT/$db.dump"; done
    ${corrupt ? 'head -c 300 "$OUT/shop.dump" > /tmp/t && cat /tmp/t > "$OUT/shop.dump"' : 'true'}
    ( cd "$OUT" && ls -l ) > "$OUT/MANIFEST"`, {}, { image: PG_IMAGE, user: '999:999' });
  assert.equal(r.code, 0, r.log);
  r = tools(`aws --endpoint-url "$S3_ENDPOINT" s3 cp --recursive --quiet /work/${dir} s3://${PGDUMP}/${PREFIX}/${st}/`, { S3_BUCKET: PGDUMP });
  assert.equal(r.code, 0, r.log);
  void out;
}

/** The rendered pg-fetch then pg-drill, sharing one EMPTY /work (the pod's emptyDir). */
function drill(name, extra = {}) {
  const work = emptyDir(join(WORK, name, 'work'));
  const common = {
    network: P,
    dirs: { '/work': work },
    secrets: { AWS_ACCESS_KEY_ID: S3ENV.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: S3ENV.AWS_SECRET_ACCESS_KEY, LIVE_PGUSER: 'postgres', LIVE_PGPASSWORD: 'ci-only' },
  };
  let r = runRendered('pg-fetch', { ...common, image: 'soa-backup-tools:wp56', dirs: { ...common.dirs, '/tmp': emptyDir(join(WORK, name, 'tmp1')) },
    env: { S3_ENDPOINT: S3ENV.S3_ENDPOINT, S3_BUCKET: PGDUMP, PG_DUMP_PREFIX: PREFIX, HTTPS_PROXY: null, NO_PROXY: null, ...extra } });
  assert.equal(r.code, 0, r.log);
  r = runRendered('pg-drill', { ...common, image: PG_IMAGE,
    // tmpfs: the scratch server's Unix socket lives in /tmp, and a host bind mount on a desktop VM
    // cannot hold sockets (a pod's emptyDir can).
    dirs: { ...common.dirs, '/tmp': 'tmpfs', '/var/run/postgresql': 'tmpfs' },
    env: { LIVE_PGHOST: 'pg', ...extra } });
  assert.equal(r.code, 0, r.log);
  return { res: JSON.parse(readFileSync(join(work, 'results', 'postgres.json'), 'utf8')), log: r.log, work };
}

test('setup: live data in two databases', () => {
  psql(`psql -q -d postgres -c 'DROP DATABASE IF EXISTS shop' -c 'DROP DATABASE IF EXISTS crm' -c 'DROP DATABASE IF EXISTS blank' -c 'CREATE DATABASE shop' -c 'CREATE DATABASE crm'
    psql -q -d shop -c 'CREATE TABLE orders(id int primary key, total numeric)' -c 'INSERT INTO orders SELECT g, g*1.5 FROM generate_series(1,30) g' \\
      -c 'CREATE SCHEMA sales' -c 'CREATE TABLE sales.leads(id int)' -c 'INSERT INTO sales.leads SELECT generate_series(1,20)'
    psql -q -d crm -c 'CREATE TABLE contacts(id int)' -c 'INSERT INTO contacts SELECT generate_series(1,12)'
    psql -q -d postgres -c "DO \\$\\$BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='app') THEN CREATE ROLE app LOGIN PASSWORD 'not-a-secret'; END IF; END\\$\\$"`);
  cleanBucket();
});

test('NEGATIVE: no dump run in the bucket ⇒ fail, never pass', () => {
  const { res } = drill('pg-none');
  assert.equal(res.status, 'fail');
  assert.match(res.reason, /no pg-dump run/);
});

test('the latest pg-dump restores into a scratch Postgres 17, matches live, and is deleted at once', () => {
  const st = stamp(1);
  dumpRun('pg-ok-dump', st);
  const { res, log, work } = drill('pg-ok');
  assert.equal(res.status, 'pass', JSON.stringify(res) + log);
  assert.equal(res.source, st);
  const shop = res.databases.find((d) => d.database === 'shop');
  assert.equal(shop.tables, 2);
  assert.equal(shop.rows, 50);
  assert.equal(res.databases.find((d) => d.database === 'crm').rows, 12);
  // N3: the downloaded dumps — globals.sql with role password hashes — are gone already.
  assert.deepEqual(readdirSync(work).sort(), ['results'], 'only the result is left in /work');
  assert.equal(existsSync(join(work, 'data', 'pg', 'globals.sql')), false);
});

test('NEGATIVE: a restored table far from live (rows added since the dump) fails', () => {
  psql(`psql -q -d crm -c 'INSERT INTO contacts SELECT generate_series(13,200)'`);
  const { res } = drill('pg-drift');
  assert.equal(res.status, 'fail', JSON.stringify(res));
  assert.match(res.databases.find((d) => d.database === 'crm').reason, /restored 12 rows, live 200/);
  psql(`psql -q -d crm -c 'DELETE FROM contacts WHERE id > 12'`);
});

test('NEGATIVE: a database with no table (an empty dump) fails, and a live database missing from the dump fails', () => {
  psql(`psql -q -d postgres -c 'CREATE DATABASE blank'`);
  let { res } = drill('pg-missing');
  assert.equal(res.status, 'fail');
  assert.match(res.reason, /differ from live/, 'blank is live but not in the dump');
  cleanBucket();
  dumpRun('pg-blank-dump', stamp(0.5));
  ({ res } = drill('pg-blank'));
  assert.equal(res.status, 'fail', JSON.stringify(res));
  assert.match(res.databases.find((d) => d.database === 'blank').reason, /holds no table/);
  psql(`psql -q -d postgres -c 'DROP DATABASE blank'`);
});

test('NEGATIVE: a stale newest run fails on its age', () => {
  cleanBucket();
  dumpRun('pg-old-dump', stamp(72));
  const { res } = drill('pg-old');
  assert.equal(res.status, 'fail');
  assert.match(res.reason, /h old, above the 26 h limit/);
});

test('NEGATIVE: a corrupted dump in the NEWEST run fails the drill', () => {
  cleanBucket();
  dumpRun('pg-ok2-dump', stamp(2));
  const st = stamp(0.2);
  dumpRun('pg-bad-dump', st, { corrupt: true });
  const { res } = drill('pg-bad');
  assert.equal(res.status, 'fail', JSON.stringify(res));
  assert.equal(res.source, st, 'the newest run is the one checked');
  assert.equal(res.databases.find((d) => d.database === 'shop').status, 'fail');
});
