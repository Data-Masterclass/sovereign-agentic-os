/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * Helpers for the WP-56 integration tests. Every script runs exactly as the chart runs it: the
 * same image (backup-tools / the chart's postgres image), the chart's files mounted at the
 * chart's paths, against the real SeaweedFS and Postgres that `up.sh` started.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const P = process.env.SOA_BK_PREFIX ?? 'soa-bk';
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FILES = join(ROOT, 'charts', 'sovereign-agentic-os', 'files');
export const TOOLS = 'soa-backup-tools:wp56';
export const BUNDLES = 'soa-bundles';
export const PGDUMP = 'soa-pgdump';
/** The chart's own postgres image (`postgres.plainImage`), the one the pg-dump CronJob runs. */
export const PG_IMAGE = (() => {
  const v = readFileSync(join(ROOT, 'charts', 'sovereign-agentic-os', 'values.yaml'), 'utf8');
  const m = v.match(/plainImage:\s*\n\s*repository: (\S+)\s*\n\s*tag: "?([^"\n]+)"?\s*\n\s*digest: (\S+)/);
  if (!m) throw new Error('postgres.plainImage not found in values.yaml');
  return `${m[1]}:${m[2]}@${m[3]}`;
})();
export const WORK = (() => {
  try {
    return readFileSync(join(process.env.TMPDIR ?? tmpdir(), `${P}.work`), 'utf8').trim();
  } catch {
    throw new Error(`no ${P} stack: run \`bash tests/backup/up.sh\` first`);
  }
})();

export function docker(args, input) {
  const r = spawnSync('docker', args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/** Run a shell snippet in the backup-tools image with the chart's scripts and the S3 env. */
export function tools(script, env = {}, opts = {}) {
  const args = ['run', '--rm', '--network', P, '--user', opts.user ?? '65532:65532', '--env-file', join(WORK, 's3.env'),
    '-v', `${join(FILES, 'backup')}:/opt/soa/backup:ro`, '-v', `${WORK}:/work`, '-e', 'BACKUP_LIB=/opt/soa/backup/lib.sh',
    '-e', `S3_BUCKET=${env.S3_BUCKET ?? BUNDLES}`, '-e', 'GIT_AUTHOR_NAME=ci', '-e', 'GIT_AUTHOR_EMAIL=ci@example.test',
    '-e', 'GIT_COMMITTER_NAME=ci', '-e', 'GIT_COMMITTER_EMAIL=ci@example.test'];
  for (const [k, v] of Object.entries(env)) if (k !== 'S3_BUCKET') args.push('-e', `${k}=${v}`);
  for (const v of opts.volumes ?? []) args.push('-v', v);
  args.push('--entrypoint', '/bin/sh', opts.image ?? TOOLS, '-c', script);
  const r = docker(args);
  return { code: r.code, log: r.out + r.err };
}

/** Parse the JSON log lines a script printed. */
export function events(log) {
  return log.split('\n').flatMap((l) => {
    try {
      const j = JSON.parse(l);
      return j && typeof j === 'object' ? [j] : [];
    } catch {
      return [];
    }
  });
}

/** A fresh work sub-directory (inside the shared, container-visible work dir). */
export function fresh(name) {
  const d = join(WORK, name);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  spawnSync('chmod', ['-R', 'a+rwX', d]);
  return d;
}

/** Read an object from a bucket (null when absent). */
export function s3cat(key, bucket = BUNDLES) {
  const r = tools(`aws --endpoint-url "$S3_ENDPOINT" s3 cp "s3://${bucket}/${key}" -`, { S3_BUCKET: bucket });
  return r.code === 0 ? r.log : null;
}

export function writeJson(path, v) {
  writeFileSync(path, JSON.stringify(v));
  spawnSync('chmod', ['a+r', path]);
}
