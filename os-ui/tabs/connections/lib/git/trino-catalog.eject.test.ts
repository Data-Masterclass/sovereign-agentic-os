/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        connections
 * FEATURE:    WP-50 EJECT TEST (design 11 A10 row d, AT-f) — the committed catalog file loads in a
 *             plain Trino, with no OS present
 * USER STORY: As an engineer leaving the OS I want `connections/<catalog>/catalog.properties` from
 *             my repo to work in an upstream Trino container exactly as committed: I mount the
 *             file, set the env var the file names, and `SHOW SCHEMAS FROM <catalog>` answers.
 * ARCHITECTURE:
 *   - REAL CONTAINERS ONLY: the chart's own Trino pin (`trino.image`) and the chart's plain Postgres
 *     pin (`postgres.plainImage`), read from `charts/sovereign-agentic-os/values.yaml` — no version
 *     is spelled here. Runs only with `WP50_EJECT=1` (CI job `artifacts-eject`); otherwise skipped,
 *     and the skip says why.
 *   - The repo files come from the real commit path (`commitConnections` into a temp bare repo)
 *     and are read back with `git archive`-equivalent `readFilesAt`; every OS-layer file
 *     (`os.yaml`, READMEs) is DELETED before Trino sees the folder, as AT-f prescribes.
 *   - NEGATIVE TWINS (must go red): (1) the same file with the env var holding a WRONG password
 *     fails `SHOW SCHEMAS` — so a pass proves the real authenticated hop, not a cached listing;
 *     (2) a catalog with an unknown `connector.name` stops Trino from starting at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import yaml from 'js-yaml';
import { listTree, readBlob } from '@core/infra/git-store';
import { commitConnections, __setConnectionsGitForTests } from '@tabs/connections/lib/git/commit';
import type { SnapshotConnection } from '@tabs/connections/lib/git/generate';

const ENABLED = process.env.WP50_EJECT === '1';
const SKIP = ENABLED ? false : 'set WP50_EJECT=1 to run the real-container eject test (CI job artifacts-eject)';
const VALUES = join(import.meta.dirname, '..', '..', '..', '..', '..', 'charts', 'sovereign-agentic-os', 'values.yaml');

type Img = { repository: string; tag: string; digest?: string };
function ref(i: Img): string {
  return `${i.repository}:${i.tag}${i.digest ? `@${i.digest}` : ''}`;
}
function chartImages(): { trino: string; postgres: string } {
  const v = yaml.load(readFileSync(VALUES, 'utf8')) as { trino: { image: Img }; postgres: { plainImage: Img } };
  return { trino: ref(v.trino.image), postgres: ref(v.postgres.plainImage) };
}

const RUN = `wp50-eject-${randomBytes(3).toString('hex')}`;
function docker(args: string[], opts: { allowFail?: boolean } = {}): { code: number; out: string } {
  const r = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status !== 0 && !opts.allowFail) throw new Error(`docker ${args.slice(0, 3).join(' ')} failed (${r.status}): ${out.slice(-2000)}`);
  return { code: r.status ?? 1, out };
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
async function until(what: string, timeoutMs: number, probe: () => boolean): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (probe()) return;
    await sleep(2000);
  }
  throw new Error(`timed out waiting for ${what}`);
}
function trinoSql(container: string, sql: string): { code: number; out: string } {
  return docker(['exec', container, 'trino', '--output-format', 'TSV', '--execute', sql], { allowFail: true });
}

const ACTOR = { id: 'eject@example.com', name: 'Eject', email: 'eject@example.com' };
function conn(catalog: string): SnapshotConnection {
  return {
    id: `conn_${catalog}`,
    name: catalog,
    template: 'warehouse',
    owner: ACTOR.id,
    domain: 'sales',
    visibility: 'domain',
    archived: false,
    secretRef: { name: `conn-${catalog}`, key: 'password' },
    warehouse: { platform: 'postgresql', catalog, config: { host: `${RUN}-pg`, port: '5432', database: 'sales', username: 'reader' } },
  };
}

test('EJECT: the committed catalog.properties loads in plain Trino and SHOW SCHEMAS answers', { skip: SKIP, timeout: 900_000 }, async () => {
  const { trino, postgres } = chartImages();
  const work = mkdtempSync(join(tmpdir(), 'wp50-eject-'));
  const reposDir = join(work, 'repos');
  const catalogDir = join(work, 'catalog');
  const password = randomBytes(12).toString('hex');
  __setConnectionsGitForTests(true);
  try {
    // 1. The OS commit path writes the repo, exactly as a save does.
    const res = await commitConnections('sales', ACTOR, { action: 'create connection' }, { reposDir, captured: [conn('pg_sales')], mirror: false });
    assert.ok(res?.changed);

    // 2. Clone-equivalent: every tracked path at the sha. Delete the OS layer (AT-f setup).
    const tree = await listTree('sales', res!.sha, { reposDir });
    const native = tree.map((e) => e.path).filter((p) => p.startsWith('connections/') && !p.endsWith('/os.yaml') && !p.endsWith('README.md'));
    assert.deepEqual(native, ['connections/pg_sales/catalog.properties']);
    execFileSync('mkdir', ['-p', catalogDir]);
    const text = await readBlob('sales', res!.sha, native[0], { reposDir });
    writeFileSync(join(catalogDir, 'pg_sales.properties'), text);
    // Negative twin 1 rides in the same Trino: the SAME bytes under another name, whose env var
    // will hold a wrong password.
    writeFileSync(join(catalogDir, 'pg_wrong.properties'), text.replace('${ENV:POSTGRESQL_PASSWORD}', '${ENV:WRONG_PASSWORD}'));
    chmodSync(catalogDir, 0o755);

    // 3. Upstream containers only.
    docker(['network', 'create', RUN]);
    docker(['run', '-d', '--name', `${RUN}-pg`, '--network', RUN, '-e', 'POSTGRES_USER=reader', '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=sales', postgres]);
    await until('postgres', 120_000, () => docker(['exec', `${RUN}-pg`, 'pg_isready', '-U', 'reader', '-d', 'sales'], { allowFail: true }).code === 0);
    await until('postgres DDL', 60_000, () => docker(['exec', `${RUN}-pg`, 'psql', '-U', 'reader', '-d', 'sales', '-c', 'CREATE SCHEMA IF NOT EXISTS eject_proof'], { allowFail: true }).code === 0);

    docker([
      'run', '-d', '--name', `${RUN}-trino`, '--network', RUN, '--memory', '2g',
      '-e', `POSTGRESQL_PASSWORD=${password}`, '-e', 'WRONG_PASSWORD=not-the-password',
      '-v', `${join(catalogDir, 'pg_sales.properties')}:/etc/trino/catalog/pg_sales.properties:ro`,
      '-v', `${join(catalogDir, 'pg_wrong.properties')}:/etc/trino/catalog/pg_wrong.properties:ro`,
      trino,
    ]);
    await until('trino', 300_000, () => trinoSql(`${RUN}-trino`, 'SELECT 1').code === 0);

    // 4. Positive: the committed catalog answers through the real authenticated hop.
    const ok = trinoSql(`${RUN}-trino`, 'SHOW SCHEMAS FROM pg_sales');
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /^eject_proof$/m, ok.out);
    console.log(`[wp50-eject] trino ${trino}: SHOW SCHEMAS FROM pg_sales → ${ok.out.trim().split('\n').join(', ')}`);

    // 5. Negative twin 1: the same file with a wrong secret must fail.
    const bad = trinoSql(`${RUN}-trino`, 'SHOW SCHEMAS FROM pg_wrong');
    assert.notEqual(bad.code, 0, `a wrong password must not list schemas: ${bad.out}`);
    assert.match(bad.out, /password authentication failed|authentication/i);
  } finally {
    __setConnectionsGitForTests(null);
    docker(['rm', '-f', `${RUN}-trino`, `${RUN}-pg`], { allowFail: true });
    docker(['network', 'rm', RUN], { allowFail: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test('EJECT NEGATIVE TWIN: a catalog with an unknown connector stops a plain Trino from starting', { skip: SKIP, timeout: 600_000 }, async () => {
  const { trino } = chartImages();
  const work = mkdtempSync(join(tmpdir(), 'wp50-eject-bad-'));
  const name = `${RUN}-badtrino`;
  try {
    const file = join(work, 'bad.properties');
    writeFileSync(file, 'connector.name=postgresqlx\nconnection-url=jdbc:postgresql://nowhere:5432/x\n');
    chmodSync(work, 0o755);
    docker(['run', '-d', '--name', name, '--memory', '2g', '-v', `${file}:/etc/trino/catalog/bad.properties:ro`, trino]);
    let exited = false;
    await until('trino to refuse the catalog', 300_000, () => {
      const st = docker(['inspect', '-f', '{{.State.Status}}', name], { allowFail: true }).out.trim();
      exited = st === 'exited';
      return exited || trinoSql(name, 'SELECT 1').code === 0;
    });
    const logs = docker(['logs', name], { allowFail: true }).out;
    assert.ok(exited, 'Trino must not come up with an unknown connector');
    assert.match(logs, /postgresqlx/);
  } finally {
    docker(['rm', '-f', name], { allowFail: true });
    rmSync(work, { recursive: true, force: true });
  }
});
