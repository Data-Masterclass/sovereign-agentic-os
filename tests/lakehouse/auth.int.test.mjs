// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// WP-14 (design 06 §5.2, §7.1 `auth.int.test`): Trino 476 authenticates every client on its TLS
// port with the PASSWORD file authenticator, and the plain-HTTP port either stays open for the
// dual-run (`trino.auth.insecureHttp: true`, today's clients unchanged) or refuses every statement
// (`false`, the closed state). Runs on the lakehouse harness with the chart's rendered config:
//
//   LH_EXPECT_HTTP=insecure node --test tests/lakehouse/auth.int.test.mjs   # dual-run render
//   LH_EXPECT_HTTP=refused  node --test tests/lakehouse/auth.int.test.mjs   # after restrict.sh
//
// Negative twins: a password-less service user, a wrong password and no credentials are refused;
// a plain-HTTP connection is refused in the closed state. Without the chart's auth block these
// fail (8443 does not exist), which is the red run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireSecrets, wp14Skip, runTls, tls, tlsHeaders, httpPost, TRINO_TLS } from './tls.mjs';
import { run } from './lib.mjs';

const skip = wp14Skip();
const expectHttp = process.env.LH_EXPECT_HTTP ?? 'insecure';
const pw = (u) => requireSecrets().passwords[u];

test('TLS port: no credentials -> 401', { skip }, async () => {
  requireSecrets();
  const r = await tls('POST', `${TRINO_TLS}/v1/statement`, { headers: tlsHeaders({ user: 'alice@x.com' }), body: 'SELECT 1' });
  assert.equal(r.status, 401);
});

test('TLS port: a wrong password -> 401', { skip }, async () => {
  await assert.rejects(runTls('SELECT 1', { auth: ['svc-os-ui', `${pw('svc-os-ui')}x`] }), (e) => e.status === 401);
});

test('TLS port: a service user without a password entry (legacy dbt-runner) -> 401', { skip }, async () => {
  await assert.rejects(runTls('SELECT 1', { auth: ['dbt-runner', ''] }), (e) => e.status === 401);
  await assert.rejects(runTls('SELECT 1', { auth: ['dbt-runner', 'anything'] }), (e) => e.status === 401);
});

test('TLS port: a known service user with an empty password -> 401', { skip }, async () => {
  await assert.rejects(runTls('SELECT 1', { auth: ['svc-os-worker', ''] }), (e) => e.status === 401);
});

test('TLS port: every chart service user authenticates and is its own session user', { skip }, async () => {
  const sec = requireSecrets();
  // WP-15 (P1): the users that only ever act for someone have no rights of their own, so as
  // themselves they authenticate (no 401) and are then refused by policy (PERMISSION_DENIED).
  const impersonateOnly = new Set(['svc-dagster-runner', 'svc-os-worker']);
  for (const u of Object.keys(sec.passwords)) {
    if (impersonateOnly.has(u)) {
      await assert.rejects(runTls('SELECT current_user', { auth: [u, pw(u)] }), (e) => e.status === 200 && e.errorName === 'PERMISSION_DENIED', u);
      continue;
    }
    const { rows } = await runTls('SELECT current_user', { auth: [u, pw(u)] });
    assert.deepEqual(rows, [[u]], u);
  }
  assert.ok(['svc-os-ui', 'svc-os-worker', 'svc-dagster-runner'].every((u) => u in sec.passwords), 'the three impersonating service users are rendered');
});

test('TLS port: a client that does not trust the chart CA is refused at the handshake', { skip }, async () => {
  requireSecrets();
  await assert.rejects(tls('GET', `${TRINO_TLS}/v1/info`, { ca: '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUZ\n-----END CERTIFICATE-----\n' }));
});

if (expectHttp === 'refused') {
  test('plain HTTP (closed state): a statement without credentials is refused', { skip }, async () => {
    const r = await httpPost('SELECT 1', { 'X-Trino-User': 'alice@x.com' });
    assert.equal(r.status, 403, r.text);
  });

  test('plain HTTP (closed state): a statement WITH valid credentials is refused too', { skip }, async () => {
    const r = await httpPost('SELECT 1', { Authorization: `Basic ${Buffer.from(`svc-os-ui:${pw('svc-os-ui')}`).toString('base64')}` });
    assert.equal(r.status, 403, r.text);
  });

  test('plain HTTP (closed state): the Dagster run pod must have moved to TLS', { skip }, async () => {
    const r = await httpPost('SELECT 1', { Authorization: `Basic ${Buffer.from('dbt-runner:').toString('base64')}`, 'X-Trino-User': 'sales' });
    assert.equal(r.status, 403, r.text);
  });
} else {
  test('plain HTTP (dual-run): a legacy client still runs as its X-Trino-User, as today', { skip }, async () => {
    const r = await httpPost('SELECT current_user', { 'X-Trino-User': 'alice@x.com', 'X-Trino-Source': 'lh-wp14' });
    assert.equal(r.status, 200, r.text);
  });

  test('plain HTTP (dual-run): the Dagster run pod connects as today (dbt-trino method none: no Authorization)', { skip }, async () => {
    // dbt-trino 1.9.3 `TrinoNoneCredentials` sends no Authorization header and has no
    // impersonation_user, so the session user is its `user` (TRINO_USER): no impersonation today.
    const { rows } = await run('SELECT current_user', { user: 'dbt-runner', source: 'dbt-trino-1.9.3' });
    assert.deepEqual(rows, [['dbt-runner']]);
  });

  test('plain HTTP (dual-run): a password-less user cannot impersonate there either', { skip }, async () => {
    await assert.rejects(
      run('SELECT current_user', { user: 'sales', principal: 'dbt-runner', source: 'dbt-trino-1.9.3' }),
      (e) => e.errorName === 'PERMISSION_DENIED',
    );
  });

  test('plain HTTP (dual-run): a password is never accepted over plain HTTP', { skip }, async () => {
    const r = await httpPost('SELECT 1', { Authorization: `Basic ${Buffer.from(`svc-os-ui:${pw('svc-os-ui')}`).toString('base64')}` });
    assert.equal(r.status, 401, r.text);
  });
}
