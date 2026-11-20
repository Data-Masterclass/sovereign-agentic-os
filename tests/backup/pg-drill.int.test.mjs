/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * WP-56 — the Postgres restore drill against a REAL Postgres 17 (the chart's postgres image) and
 * SeaweedFS. The dump is made with the SAME commands and layout as the chart's pg-dump CronJob
 * (pg_dumpall --globals-only, pg_dump -Fc per database, MANIFEST, s3://<bucket>/<prefix>/<stamp>/);
 * the drill restores it into a SCRATCH server inside its own container, never the live one.
 * Negative twins: a corrupted dump and a bucket with no run must fail.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tools, fresh, PG_IMAGE, PGDUMP } from './harness.mjs';

const PREFIX = 't-pg';
const live = `export PGHOST=pg PGUSER=postgres PGPASSWORD=ci-only`;

function dumpRun(dir, stamp, { corrupt = false } = {}) {
  // Same commands as templates/extensions/backup/pg-dump-cronjob.yaml (init container `dump`).
  let r = tools(`set -e; ${live}; OUT=/work/${dir}/dumps/${stamp}; mkdir -p $OUT
    DBS=$(psql -d postgres -Atc "SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres' ORDER BY 1")
    pg_dumpall --globals-only > "$OUT/globals.sql"
    for db in $DBS; do pg_dump -Fc -d "$db" -f "$OUT/$db.dump"; done
    ${corrupt ? 'head -c 300 "$OUT/shop.dump" > /tmp/t && cat /tmp/t > "$OUT/shop.dump"' : 'true'}
    ( cd "$OUT" && ls -l ) > "$OUT/MANIFEST"; chmod -R a+rwX /work/${dir}/dumps`, {}, { image: PG_IMAGE, user: '999:999' });
  assert.equal(r.code, 0, r.log);
  r = tools(`aws --endpoint-url "$S3_ENDPOINT" s3 cp --recursive --quiet /work/${dir}/dumps/${stamp} s3://${PGDUMP}/${PREFIX}/${stamp}/`, { S3_BUCKET: PGDUMP });
  assert.equal(r.code, 0, r.log);
}


function runDrill(name) {
  const dir = fresh(name);
  const env = { S3_BUCKET: PGDUMP, PG_DUMP_PREFIX: PREFIX, DRILL_DATA: `/work/${name}/data`, RESULTS_DIR: `/work/${name}/results` };
  // In the chart every container of the drill pod runs as uid 999; here two images with two uids share
  // the work dir, so the results dir is made writable for both.
  let r = tools(`mkdir -p /work/${name}/results /work/${name}/data && chmod a+rwx /work/${name}/results && sh /opt/soa/backup/drill-pg-fetch.sh`, env);
  assert.equal(r.code, 0, r.log);
  r = tools('bash /opt/soa/backup/drill-pg.sh', env, { image: PG_IMAGE, user: '999:999' });
  assert.equal(r.code, 0, r.log);
  return { res: JSON.parse(readFileSync(join(dir, 'results', 'postgres.json'), 'utf8')), log: r.log };
}

test('setup: live data in two databases', () => {
  const r = tools(`set -e; ${live}
    psql -q -d postgres -c 'DROP DATABASE IF EXISTS shop' -c 'DROP DATABASE IF EXISTS crm' -c 'CREATE DATABASE shop' -c 'CREATE DATABASE crm'
    psql -q -d shop -c 'CREATE TABLE orders(id int primary key, total numeric)' -c 'INSERT INTO orders SELECT g, g*1.5 FROM generate_series(1,3) g' \\
      -c 'CREATE SCHEMA sales' -c 'CREATE TABLE sales.leads(id int)' -c 'INSERT INTO sales.leads VALUES (1),(2)'
    psql -q -d crm -c 'CREATE TABLE contacts(id int)'
    psql -q -d postgres -c "DO \\$\\$BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='app') THEN CREATE ROLE app LOGIN; END IF; END\\$\\$"`,
    {}, { image: PG_IMAGE, user: '999:999' });
  assert.equal(r.code, 0, r.log);
  const clean = tools(`aws --endpoint-url "$S3_ENDPOINT" s3 rm --recursive --quiet s3://${PGDUMP}/${PREFIX}/`, { S3_BUCKET: PGDUMP });
  assert.equal(clean.code, 0, clean.log);
});

test('NEGATIVE: no dump run in the bucket ⇒ fail, never pass', () => {
  const { res } = runDrill('pg-none');
  assert.equal(res.status, 'fail');
  assert.match(res.reason, /no pg-dump run/);
});

test('the latest pg-dump restores into a scratch Postgres 17 and the sanity queries pass', () => {
  const dir = fresh('pg-ok');
  dumpRun('pg-ok', '2026-11-20T02-30-00Z');
  void dir;
  const { res, log } = runDrill('pg-ok-drill');
  assert.equal(res.status, 'pass', JSON.stringify(res) + log);
  assert.equal(res.source, '2026-11-20T02-30-00Z');
  const shop = res.databases.find((d) => d.database === 'shop');
  assert.equal(shop.tables, 2);
  assert.equal(shop.rows, 5);
  assert.equal(res.databases.find((d) => d.database === 'crm').status, 'pass');
});

test('NEGATIVE: a corrupted dump in the NEWEST run fails the drill', () => {
  fresh('pg-bad');
  dumpRun('pg-bad', '2026-11-21T02-30-00Z', { corrupt: true });
  const { res } = runDrill('pg-bad-drill');
  assert.equal(res.status, 'fail', JSON.stringify(res));
  assert.equal(res.source, '2026-11-21T02-30-00Z', 'the newest run is the one checked');
  assert.equal(res.databases.find((d) => d.database === 'shop').status, 'fail');
});
