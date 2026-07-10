/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword } from './password.ts';
import {
  __setMailTransportForTests,
  __resetGraphTokenCacheForTests,
  emailVerificationEnabled,
  mailerConfigured,
  selectMailer,
  sendVerificationEmail,
  type OutgoingMail,
} from '../infra/mailer.ts';
import { __resetUsers } from '../platform-admin/users.ts';

/**
 * Self-hosted onboarding security: the bootstrap admin must become active with
 * NO mailer (clone-and-run), the default admin/admin must be gone the instant
 * setup completes, email verification is OPTIONAL (gated on a configured mailer),
 * and runtime-created accounts must survive a restart via the OpenSearch mirror.
 * The pluggable mailer must select Graph > SMTP > none and actually drive the
 * Graph client-credentials + sendMail path.
 *
 * An in-process OpenSearch stub stands in for the durable mirror so the "survives
 * a restart" path is the REAL persistence mechanism, not a mock of it.
 */

// ---- fetch stub (OpenSearch "os-users" + Microsoft Graph) -------------------

type Stub = (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => Promise<Response>;
let activeFetch: Stub | null = null;
const realFetch = globalThis.fetch;
globalThis.fetch = ((url: string, init?: { method?: string; body?: string }) =>
  activeFetch ? activeFetch(url, init) : realFetch(url as string, init)) as typeof fetch;

function jsonRes(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

function openSearchStub(): { store: Map<string, Record<string, unknown>>; stub: Stub } {
  const store = new Map<string, Record<string, unknown>>();
  const stub: Stub = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const method = (init.method ?? 'GET').toUpperCase();
    if (path === '/os-users/_count') return jsonRes({ count: store.size });
    if (path === '/os-users/_search') {
      return jsonRes({ hits: { hits: [...store.values()].map((_source) => ({ _source })) } });
    }
    const m = path.match(/^\/os-users\/_doc\/(.+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (method === 'PUT') {
        store.set(id, JSON.parse(init.body ?? '{}'));
        return jsonRes({ result: 'created' });
      }
      if (method === 'DELETE') {
        store.delete(id);
        return jsonRes({ result: 'deleted' });
      }
    }
    return jsonRes({}, 404);
  };
  return { store, stub };
}

// Reset every mailer-affecting env + the test seams to a known clean state.
function resetMailerEnv(): void {
  __setMailTransportForTests(null);
  __resetGraphTokenCacheForTests();
  for (const k of [
    'GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET', 'MAIL_FROM',
    'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_SECURE', 'SMTP_FROM',
    'OS_EMAIL_VERIFICATION', 'OS_PUBLIC_URL',
  ]) {
    delete process.env[k];
  }
}

// Clear the globalThis-pinned users state before every test so tests don't bleed.
beforeEach(() => __resetUsers());

// Fresh module instance == a process restart (in-memory cache is gone; only the
// stubbed OpenSearch mirror survives).
let v = 0;
async function freshUsers() {
  v += 1;
  return import(`../platform-admin/users.ts?case=${v}`);
}

const STRONG = 'Tr0ub4dour&3-horses';

// ---- Mailer: selection + transports -----------------------------------------

test('transport selection precedence: Graph > SMTP > none, and the gate', () => {
  resetMailerEnv();
  assert.equal(selectMailer(), 'none');
  assert.equal(mailerConfigured(), false);
  assert.equal(emailVerificationEnabled(), false);

  process.env.SMTP_HOST = 'smtp.example.com';
  assert.equal(selectMailer(), 'smtp');
  assert.equal(emailVerificationEnabled(), true);

  process.env.GRAPH_TENANT_ID = 't';
  process.env.GRAPH_CLIENT_ID = 'c';
  process.env.GRAPH_CLIENT_SECRET = 's';
  assert.equal(selectMailer(), 'graph', 'Graph wins when both are configured');

  // Partial Graph config does NOT count as configured (falls back to SMTP).
  delete process.env.GRAPH_CLIENT_SECRET;
  assert.equal(selectMailer(), 'smtp');

  // Force-disable verification even with a mailer present.
  process.env.OS_EMAIL_VERIFICATION = 'false';
  assert.equal(emailVerificationEnabled(), false);
  resetMailerEnv();
});

test('Graph transport: client-credentials token fetched + cached, sendMail posted correctly', async () => {
  resetMailerEnv();
  process.env.GRAPH_TENANT_ID = 'tenant-1';
  process.env.GRAPH_CLIENT_ID = 'client-1';
  process.env.GRAPH_CLIENT_SECRET = 'super-secret-value';
  process.env.MAIL_FROM = 'support@datamasterclass.com';
  assert.equal(selectMailer(), 'graph');
  assert.equal(emailVerificationEnabled(), true);

  let tokenCalls = 0;
  const sends: { url: string; auth?: string; body: Record<string, unknown> }[] = [];
  activeFetch = async (url, init = {}) => {
    if (url.startsWith('https://login.microsoftonline.com/')) {
      tokenCalls += 1;
      // The client secret travels only in the token request body.
      assert.ok((init.body ?? '').includes('client_credentials'));
      return jsonRes({ access_token: 'tok-abc', expires_in: 3600 });
    }
    if (url.startsWith('https://graph.microsoft.com/v1.0/users/')) {
      sends.push({ url, auth: init.headers?.authorization, body: JSON.parse(init.body ?? '{}') });
      return new Response('', { status: 202 }); // Graph success
    }
    return jsonRes({}, 404);
  };

  const ok1 = await sendVerificationEmail('carol@example.com', 'https://os.example.com/api/auth/verify?token=carol.abc');
  const ok2 = await sendVerificationEmail('dave@example.com', 'https://os.example.com/api/auth/verify?token=dave.xyz');
  assert.equal(ok1, true);
  assert.equal(ok2, true);
  assert.equal(tokenCalls, 1, 'app token is cached across sends');
  assert.equal(sends.length, 2);
  assert.ok(sends[0].url.includes('/users/support%40datamasterclass.com/sendMail'));
  assert.equal(sends[0].auth, 'Bearer tok-abc');
  const msg = (sends[0].body as { message: { subject: string; toRecipients: { emailAddress: { address: string } }[]; body: { content: string } } }).message;
  assert.equal(msg.toRecipients[0].emailAddress.address, 'carol@example.com');
  assert.ok(msg.subject.includes('Verify your email'));
  assert.ok(msg.body.content.includes('Verify email'));
  assert.ok(!JSON.stringify(sends[0].body).includes('super-secret-value'), 'secret never in the message payload');

  activeFetch = null;
  resetMailerEnv();
});

test('mailer failure is swallowed (best-effort, never throws)', async () => {
  resetMailerEnv();
  process.env.GRAPH_TENANT_ID = 'tenant-1';
  process.env.GRAPH_CLIENT_ID = 'client-1';
  process.env.GRAPH_CLIENT_SECRET = 's';
  activeFetch = async () => new Response('nope', { status: 500 });
  const ok = await sendVerificationEmail('x@example.com', 'https://os.example.com/api/auth/verify?token=x.y');
  assert.equal(ok, false, 'returns false rather than throwing');
  activeFetch = null;
  resetMailerEnv();
});

// ---- Onboarding flow (transport-agnostic via injected transport) ------------

test('no mailer: a new account is active immediately (no email round-trip, no dead-end)', async () => {
  resetMailerEnv();
  assert.equal(mailerConfigured(), false);
  assert.equal(emailVerificationEnabled(), false);

  const { store, stub } = openSearchStub();
  activeFetch = stub;
  const users = await freshUsers();
  const created = await users.createUser({
    id: 'bob',
    password: STRONG,
    domains: ['sales'],
    role: 'creator',
    email: 'bob@example.com',
  });
  assert.equal(created.emailVerified, true, 'active without an email round-trip');
  assert.equal((await users.getPublicUser('bob'))?.emailVerified, true);
  const stored = store.get('bob') as { pendingVerifyHash?: string };
  assert.equal(stored.pendingVerifyHash, undefined, 'no pending token to dead-end on');
  activeFetch = null;
});

test('mailer on: invited account gets a verification email and the token verifies (single-use)', async () => {
  const outbox: OutgoingMail[] = [];
  resetMailerEnv();
  __setMailTransportForTests(async (mail) => {
    outbox.push(mail);
  });
  assert.equal(mailerConfigured(), true, 'a transport counts as a configured mailer');
  assert.equal(emailVerificationEnabled(), true);

  const { stub } = openSearchStub();
  activeFetch = stub;
  const users = await freshUsers();
  const created = await users.createUser({
    id: 'carol',
    password: STRONG,
    domains: ['sales'],
    role: 'creator',
    email: 'carol@example.com',
  });
  assert.equal(created.emailVerified, false, 'starts unverified when a mailer is on');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].to, 'carol@example.com');
  assert.ok(!outbox[0].text.includes('scrypt$'), 'no secret/hash leaks into the email');
  const token = (outbox[0].text.match(/token=([^\s"&]+)/) ?? [])[1];
  assert.ok(token, 'a verification token is present in the email');

  const r1 = await users.verifyEmailToken(token!);
  assert.deepEqual(r1, { ok: true, userId: 'carol' });
  assert.equal((await users.getPublicUser('carol'))?.emailVerified, true);
  assert.equal((await users.verifyEmailToken(token!)).ok, false, 'single-use');

  resetMailerEnv();
  activeFetch = null;
});

test('bootstrap setup auto-verifies and deletes admin/admin right then (no mailer)', async () => {
  resetMailerEnv();
  const { store, stub } = openSearchStub();
  activeFetch = stub;
  const users = await freshUsers();

  assert.ok(await users.authenticate('admin', 'admin'));

  const { user } = await users.setupAdmin({
    bootstrapId: 'admin',
    username: 'ada',
    email: 'ada@example.com',
    passwordHashReady: await hashPassword(STRONG),
  });
  assert.equal(user.emailVerified, true, 'trusted bootstrap operator is active immediately');
  assert.equal(user.mustChangeCredentials, false);

  assert.equal(await users.authenticate('admin', 'admin'), null);
  assert.equal(store.has('admin'), false);
  assert.equal(store.has('__bootstrap_tombstone__'), false);
  assert.deepEqual((await users.listUsers()).map((u) => u.id), ['ada']);
  assert.ok(await users.authenticate('ada', STRONG));
  activeFetch = null;
});

test('accounts survive a simulated restart (durable via the OpenSearch mirror)', async () => {
  resetMailerEnv();
  const { stub } = openSearchStub(); // one persistent "database" across both boots
  activeFetch = stub;

  const boot1 = await freshUsers();
  await boot1.setupAdmin({
    bootstrapId: 'admin',
    username: 'ada',
    email: 'ada@example.com',
    passwordHashReady: await hashPassword(STRONG),
  });

  const boot2 = await freshUsers();
  assert.ok(await boot2.authenticate('ada', STRONG), 'admin persists across restart');
  assert.equal((await boot2.getPublicUser('ada'))?.emailVerified, true);
  assert.equal(await boot2.authenticate('admin', 'admin'), null);
  activeFetch = null;
});
