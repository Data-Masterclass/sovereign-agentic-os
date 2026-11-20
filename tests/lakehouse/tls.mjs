// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// WP-14 helpers: Trino's client protocol over the chart's TLS port, as a service user with a
// password (https://trino.io/docs/476/develop/client-protocol.html,
// https://trino.io/docs/476/security/password-file.html). The CA and the passwords are the ones
// the chart rendered for this run (tests/lakehouse/render.py writes them to the work dir, never to
// stdout). OPA data goes to the Trino pod's OPA sidecar, which listens on 127.0.0.1 inside the
// Trino container only, so it is written from inside that container: the same documents os-ui
// PUTs today and WP-11 will ship as bundles.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TRINO_TLS = process.env.LH_TRINO_TLS_URL ?? `https://127.0.0.1:${process.env.LH_TRINO_TLS_PORT ?? '18443'}`;
export const TRINO_HTTP = process.env.LH_TRINO_URL ?? `http://127.0.0.1:${process.env.LH_TRINO_PORT ?? '18080'}`;

/** The harness work dir up.sh recorded, or null when the harness is not running. */
export function workDir() {
  const state = join(process.env.TMPDIR ?? tmpdir(), 'soa-lakehouse.work');
  if (process.env.LH_WORK) return process.env.LH_WORK;
  return existsSync(state) ? readFileSync(state, 'utf8').trim() : null;
}

/** `{ ca, passwords: {user: pw}, httpMode }` for this run (render.py). */
export function harnessSecrets() {
  const w = workDir();
  if (!w || !existsSync(join(w, 'test-secrets.json'))) return null;
  return JSON.parse(readFileSync(join(w, 'test-secrets.json'), 'utf8'));
}

/** Skip reason for a WP-14 test, or false. In CI (or when LH_EXPECT_HTTP is set) a harness
 *  without the chart's auth block is a FAILURE, not a skip: the red run must be red. */
export function wp14Skip() {
  if (harnessSecrets() || process.env.CI || process.env.LH_EXPECT_HTTP) return false;
  return 'no WP-14 harness secrets (start tests/lakehouse/up.sh on a chart with trino.auth)';
}

/** The run's secrets, or a clear failure. */
export function requireSecrets() {
  const s = harnessSecrets();
  if (!s) throw new Error('the rendered chart has no Trino auth (no test-secrets.json in the harness work dir)');
  return s;
}

/** One HTTPS exchange that trusts only the chart's CA. Resolves `{status, text, headers}`. */
export function tls(method, url, { headers = {}, body, ca } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers, ca: ca ?? harnessSecrets()?.ca, timeout: 60000 }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`timeout ${method} ${url}`)));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const basic = (u, p) => `Basic ${Buffer.from(`${u}:${p ?? ''}`).toString('base64')}`;

/** Client headers. `auth` = [user, password] (Authorization: Basic); `user` = X-Trino-User. */
export function tlsHeaders({ auth, user, source = 'lh-wp14', extra = {} } = {}) {
  const h = { 'Content-Type': 'text/plain', 'X-Trino-Source': source, ...extra };
  if (auth) h.Authorization = basic(auth[0], auth[1]);
  if (user) h['X-Trino-User'] = user;
  return h;
}

/**
 * Run one statement over TLS to completion. Resolves `{ rows, columns, status }` or throws with
 * Trino's own `errorName` / `status` (401 from the authenticator, an error object from a denied
 * statement). Follows `nextUri` with the same credentials.
 */
export async function runTls(sql, opts = {}) {
  const h = tlsHeaders(opts);
  let res = await tls('POST', `${opts.base ?? TRINO_TLS}/v1/statement`, { headers: h, body: sql });
  if (res.status !== 200) throw Object.assign(new Error(`HTTP ${res.status}: ${res.text.slice(0, 200)}`), { status: res.status });
  let r = JSON.parse(res.text);
  const rows = [];
  let columns = [];
  while (true) {
    if (r.error) throw Object.assign(new Error(`Trino: ${r.error.message}`), { errorName: r.error.errorName, status: 200, trinoMessage: r.error.message });
    if (r.columns) columns = r.columns.map((c) => c.name);
    if (r.data) rows.push(...r.data);
    if (!r.nextUri) return { rows, columns, status: 200, id: r.id };
    res = await tls('GET', r.nextUri, { headers: h });
    if (res.status !== 200) throw Object.assign(new Error(`HTTP ${res.status} on nextUri`), { status: res.status });
    r = JSON.parse(res.text);
  }
}

/** The plain-HTTP port, raw: `{status, text}` of the first POST (no redirects, no retries). */
export async function httpPost(sql, headers) {
  const res = await fetch(`${TRINO_HTTP}/v1/statement`, { method: 'POST', headers: { 'Content-Type': 'text/plain', ...headers }, body: sql });
  return { status: res.status, text: await res.text() };
}

function trinoContainer() {
  const id = execFileSync('docker', ['ps', '-q', '--filter', 'label=com.docker.compose.project=soa-lakehouse', '--filter', 'label=com.docker.compose.service=trino'], { encoding: 'utf8' }).trim();
  if (!id) throw new Error('lakehouse Trino container not running');
  return id.split('\n')[0];
}

/** Run curl inside the Trino container (where the OPA sidecar listens on 127.0.0.1:8181). */
export function inTrinoPod(args, input) {
  return execFileSync('docker', ['exec', '-i', trinoContainer(), 'curl', '-sS', ...args], { encoding: 'utf8', input });
}

/** PUT one OPA data document on the sidecar, exactly as os-ui's runtime writer does today. */
export function opaPut(path, value) {
  const out = inTrinoPod(['-o', '/dev/null', '-w', '%{http_code}', '-X', 'PUT', '-H', 'Content-Type: application/json', '--data-binary', '@-', `http://127.0.0.1:8181/v1/data/${path}`], JSON.stringify(value));
  if (out.trim() !== '204') throw new Error(`OPA PUT ${path}: HTTP ${out}`);
}

/** Remove an OPA data document (ignore 404). */
export function opaDelete(path) {
  inTrinoPod(['-o', '/dev/null', '-X', 'DELETE', `http://127.0.0.1:8181/v1/data/${path}`]);
}

/** The OPA sidecar's decision-log lines (console) since `since` (ISO). */
export function sidecarDecisions(since) {
  const id = execFileSync('docker', ['ps', '-q', '--filter', 'label=com.docker.compose.project=soa-lakehouse', '--filter', 'label=com.docker.compose.service=opa'], { encoding: 'utf8' }).trim();
  const out = execFileSync('docker', ['logs', '--since', since, id], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
  return out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((d) => d && d.decision_id);
}
