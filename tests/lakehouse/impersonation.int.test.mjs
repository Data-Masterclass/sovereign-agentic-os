// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// WP-14 (design 06 §5.4 + §7.1 `impersonation.int.test`, amended by 10 F4): on Trino 476 with the
// chart's OPA sidecar, a service user may set another session user (X-Trino-User, or SET SESSION
// AUTHORIZATION) only when OPA's `ImpersonateUser` rules allow that pair:
//   svc-os-worker      -> principal of an active, unexpired, unrevoked kind=run grant;
//   svc-dagster-runner -> principal of a kind=standing|dataset grant with an active run;
//   svc-os-ui          -> an active OS user (interim, removed at T7) or a declared principal.
// Nobody else may impersonate anyone. Grants and users are written to the sidecar as the
// `os_grants` / `os_data` documents WP-11 ships as bundles (10 F3). Negative twins: every
// "denied" case below passes on main only if Trino refused for another reason, and every
// "allowed" case fails if the rule or the file-ACL entry is missing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { requireSecrets, wp14Skip, runTls, opaPut, opaDelete, sidecarDecisions } from './tls.mjs';

const skip = wp14Skip();
const pw = (u) => requireSecrets().passwords[u];
const future = '2200-01-01T00:00:00Z';
const past = '2000-01-01T00:00:00Z';
const started = new Date(Date.now() - 1000).toISOString();

const grants = {
  'it-run': { principal_uid: 'alice@x.com', kind: 'run', active_run_id: null, expires_at: future, revoked: false },
  'it-run-expired': { principal_uid: 'erin@x.com', kind: 'run', expires_at: past, revoked: false },
  'it-run-revoked': { principal_uid: 'rob@x.com', kind: 'run', expires_at: future, revoked: true },
  'it-standing-active': { principal_uid: 'dana@x.com', kind: 'standing', active_run_id: 'dg-run-1', active_until: future, expires_at: future },
  'it-dataset-active': { principal_uid: 'dave@x.com', kind: 'dataset', active_run_id: 'dg-run-2', active_until: future, expires_at: future },
  'it-standing-idle': { principal_uid: 'ida@x.com', kind: 'standing', active_run_id: null, expires_at: future },
  // WP-14 verifier B1: a live run grant that names a SERVICE user (an OS user created with that id).
  'it-b1-svc-ui': { principal_uid: 'svc-os-ui', kind: 'run', active_run_id: null, expires_at: future, revoked: false },
};
const users = { 'alice@x.com': { active: true }, 'carol@x.com': { active: true }, 'bob@x.com': { active: false }, admin: { active: true }, 'svc-os-ui': { active: true } };

before(() => {
  if (skip) return;
  requireSecrets();
  opaPut('os_grants', { run_grants: grants });
  opaPut('os_data', { users });
});
after(() => {
  if (skip) return;
  opaDelete('os_grants');
  opaDelete('os_data');
});

/** Run `SELECT current_user` as `svc` over TLS, impersonating `target`. */
async function as(svc, target) {
  const { rows } = await runTls('SELECT current_user', { auth: [svc, pw(svc)], user: target });
  return rows[0][0];
}

const denied = (svc, target) =>
  assert.rejects(as(svc, target), (e) => e.errorName === 'PERMISSION_DENIED' && /impersonate/i.test(e.trinoMessage ?? ''), `${svc} -> ${target} must be denied`);

test('svc-os-worker acts for the principal of an active kind=run grant', { skip }, async () => {
  assert.equal(await as('svc-os-worker', 'alice@x.com'), 'alice@x.com');
});

test('svc-os-worker: no grant, an expired grant and a revoked grant are denied', { skip }, async () => {
  await denied('svc-os-worker', 'carol@x.com');
  await denied('svc-os-worker', 'erin@x.com');
  await denied('svc-os-worker', 'rob@x.com');
});

test('kind binding (10 F4): svc-os-worker cannot use a Dagster grant', { skip }, async () => {
  await denied('svc-os-worker', 'dana@x.com');
});

test('svc-dagster-runner acts for a standing or dataset grant while its run is active', { skip }, async () => {
  assert.equal(await as('svc-dagster-runner', 'dana@x.com'), 'dana@x.com');
  assert.equal(await as('svc-dagster-runner', 'dave@x.com'), 'dave@x.com');
});

test('svc-dagster-runner: a standing grant between runs and an agent (kind=run) grant are denied', { skip }, async () => {
  await denied('svc-dagster-runner', 'ida@x.com');
  await denied('svc-dagster-runner', 'alice@x.com');
});

test('svc-os-ui acts for an active user only; inactive and unknown identities are denied', { skip }, async () => {
  assert.equal(await as('svc-os-ui', 'carol@x.com'), 'carol@x.com');
  await denied('svc-os-ui', 'bob@x.com');
  await denied('svc-os-ui', 'mallory@x.com');
});

test('impersonating the wrong user: no service user may become another service user', { skip }, async () => {
  await denied('svc-os-ui', 'svc-os-worker');
  await denied('svc-os-worker', 'svc-dagster-runner');
  await denied('svc-dagster-runner', 'svc-os-ui');
});

// The client capability Trino requires before it runs SET SESSION AUTHORIZATION (the protocol's
// `X-Trino-Client-Capabilities`; trino-python-client and dbt-trino advertise it).
const SESSION_AUTH = { 'X-Trino-Client-Capabilities': 'SESSION_AUTHORIZATION' };

test('SET SESSION AUTHORIZATION inside an impersonated session is denied, even to a granted user (10 F4 case 4)', { skip }, async () => {
  // Observed on Trino 476 + the OPA plugin: the switch is checked as SESSION user -> new user
  // (here dana -> bob, dana -> dave), and dana is not a service user, so OPA denies both. A run
  // acting for its principal therefore cannot reach any other principal this way, not even one
  // with a concurrently active grant: stricter than 10 F4 assumed (it expected the authenticated
  // service user to be checked, leaving the concurrent-grant residual for max_concurrent_runs).
  const auth = ['svc-dagster-runner', pw('svc-dagster-runner')];
  for (const target of ['bob@x.com', 'dave@x.com']) {
    await assert.rejects(
      runTls(`SET SESSION AUTHORIZATION '${target}'`, { auth, user: 'dana@x.com', extra: SESSION_AUTH }),
      (e) => e.errorName === 'PERMISSION_DENIED' && e.trinoMessage.includes(`dana@x.com cannot impersonate user ${target}`),
      target,
    );
  }
  // The authenticated service user itself is still bounded by the grant rule.
  await assert.rejects(
    runTls("SET SESSION AUTHORIZATION 'bob@x.com'", { auth, extra: SESSION_AUTH }),
    (e) => e.errorName === 'PERMISSION_DENIED',
  );
});

test('the sidecar decision log records ImpersonateUser with the requested user', { skip }, async () => {
  await as('svc-os-worker', 'alice@x.com');
  const d = sidecarDecisions(started).filter((x) => x.input?.action?.operation === 'ImpersonateUser');
  assert.ok(d.length > 0, 'no ImpersonateUser decision in the sidecar log');
  const hit = d.find((x) => x.input.context?.identity?.user === 'svc-os-worker' && x.input.action.resource?.user?.user === 'alice@x.com');
  assert.ok(hit, 'the decision names the authenticated service user and the requested user');
  assert.equal(hit.result, true);
  assert.ok(d.some((x) => x.result === false), 'denials are logged too');
});

test('B1 twin: the verifier\'s escalation chain ends in PERMISSION_DENIED at every hop', { skip }, async () => {
  const worker = ['svc-os-worker', pw('svc-os-worker')];
  // Hop 1: svc-os-worker, holding a live run grant for "svc-os-ui", asks to BE svc-os-ui.
  await assert.rejects(
    runTls('SELECT current_user', { auth: worker, user: 'svc-os-ui' }),
    (e) => e.errorName === 'PERMISSION_DENIED' && e.trinoMessage.includes('cannot impersonate user svc-os-ui'),
  );
  // Hop 2: inside that would-be session, SET SESSION AUTHORIZATION 'admin'.
  await assert.rejects(
    runTls("SET SESSION AUTHORIZATION 'admin'", { auth: worker, user: 'svc-os-ui', extra: SESSION_AUTH }),
    (e) => e.errorName === 'PERMISSION_DENIED',
  );
  // Hop 3: the client's follow-up request after a switch (X-Trino-Original-User: svc-os-ui,
  // X-Trino-User: admin) is refused too; current_user is never admin.
  await assert.rejects(
    runTls('SELECT current_user', { auth: worker, user: 'admin', extra: { 'X-Trino-Original-User': 'svc-os-ui' } }),
    (e) => e.errorName === 'PERMISSION_DENIED',
  );
  // The same pair from svc-os-ui itself (an active user, admin) stays allowed by design.
  assert.equal(await as('svc-os-ui', 'admin'), 'admin');
});

test('svc-os-ui refuses an INACTIVE user even with a leftover governance principal', { skip }, async () => {
  opaPut(`governance/principals/${encodeURIComponent('bob@x.com')}`, { domains: ['sales'], clearances: [] });
  try {
    await denied('svc-os-ui', 'bob@x.com');
  } finally {
    opaDelete(`governance/principals/${encodeURIComponent('bob@x.com')}`);
  }
});
