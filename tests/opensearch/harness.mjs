/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * Helpers for the WP-21 integration tests: they talk to the stack `up.sh` started. Every call
 * to OpenSearch runs from a curl container on the INTERNAL network (the host has no route in),
 * and every Job script runs exactly as the chart's Job does: same image, same ConfigMap files,
 * same OS_* env (rendered by render.py), OPENSEARCH_URL from the chart helper's value.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const P = process.env.SOA_IT_PREFIX ?? 'soa-it';
const CURL = 'curlimages/curl:8.8.0';
export const WORK = (() => {
  try {
    return readFileSync(join(process.env.TMPDIR ?? tmpdir(), `${P}.work`), 'utf8').trim();
  } catch {
    throw new Error(`no ${P} stack: run \`bash tests/opensearch/up.sh\` first`);
  }
})();

function docker(args, input) {
  const r = spawnSync('docker', args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/** One OpenSearch REST call from inside the network. Returns { status, body }. */
export function os(method, path, body) {
  const args = ['run', '--rm', '-i', '--network', `${P}-os`, CURL, '-s', '-X', method, '-H', 'Content-Type: application/json',
    '-w', '\n%{http_code}', `http://opensearch:9200${path}`];
  if (body !== undefined) args.splice(args.length - 1, 0, '--data-binary', '@-');
  const r = docker(args, body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  const i = r.out.lastIndexOf('\n');
  const status = Number(r.out.slice(i + 1));
  const text = r.out.slice(0, i);
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status, body: json };
}

/** Run one of the chart's Job scripts (register-s3.sh / delete-orphans.sh) as its Job does. */
export function runJob(script, envFile, extraEnv = {}) {
  const args = ['run', '--rm', '--network', `${P}-os`, '--user', '100:100',
    '-v', `${join(WORK, 'render', 'soa')}:/opt/soa:ro`,
    '--env-file', join(WORK, 'render', 'env', envFile),
    '-e', 'OPENSEARCH_URL=http://opensearch:9200', '-e', 'OS_WAIT_TRIES=5'];
  for (const [k, v] of Object.entries(extraEnv)) args.push('-e', `${k}=${v}`);
  args.push('--entrypoint', '/bin/sh', CURL, `/opt/soa/${script}`);
  const r = docker(args);
  return { code: r.code, log: r.out + r.err };
}

/** Swap the proxy's allowlist: 'proxy' (chart with S3 on) or 'proxy-noroute' (S3 host absent). */
export function setProxy(dir) {
  docker(['rm', '-f', `${P}-proxy`]);
  const r = docker(['run', '-d', '--name', `${P}-proxy`, '--network', `${P}-os`, '--network-alias', 'egress-proxy',
    '-v', `${join(WORK, 'render', dir)}:/etc/tinyproxy:ro`, 'soa-egress-proxy:wp21']);
  if (r.code !== 0) throw new Error(`proxy start failed: ${r.err}`);
  const c = docker(['network', 'connect', `${P}-s3`, `${P}-proxy`]);
  if (c.code !== 0) throw new Error(`proxy connect failed: ${c.err}`);
  spawnSync('sleep', ['2']);
}

export function proxyLog() {
  const r = docker(['logs', `${P}-proxy`]);
  return r.out + r.err;
}

/** Objects the store holds under a prefix (proves the snapshot left the cluster). */
export function storeObjects(bucket) {
  const r = docker(['exec', `${P}-s3store`, 'sh', '-c', `echo 'fs.ls -l /buckets/${bucket}/opensearch' | weed shell`]);
  return r.out;
}
