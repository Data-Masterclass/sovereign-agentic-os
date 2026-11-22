/**
 * FEATURE:    Tests of the OS door: delegated identity, refusals passed on, governed write and agent run.
 * USER STORY: As the owner of this app I want proof that every call runs as the signed-in user and that a refusal is never turned into a success.
 * ARCHITECTURE: The routes run against a scripted fake OS (tests/_fake-os.ts); we assert what the app sent and what it returned.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeOs, ALICE } from './_fake-os.ts';
import { POST as addOrder } from '../src/app/api/orders/route.ts';
import { POST as ask } from '../src/app/api/ask/route.ts';

const req = (body: unknown, cookie = 'soa_session=abc') =>
  new Request('http://app/x', { method: 'POST', headers: { cookie }, body: JSON.stringify(body) });

test('a write runs as the caller: the session cookie is forwarded and the OS record is returned', async () => {
  const os = fakeOs({ 'GET /api/auth/me': ALICE, 'POST /api/apps/by-slug/orders/records': { json: { result: { source: 'os-records-store', ok: true } } } });
  try {
    const res = await addOrder(req({ amount: 50 }));
    assert.equal(res.status, 201);
    assert.ok(os.calls.length >= 2 && os.calls.every((c) => c.cookie === 'soa_session=abc'), 'every OS call carries the caller session');
    assert.deepEqual(os.calls.at(-1)?.body, { record: { amount: 50 } });
  } finally { os.restore(); }
});

test('an OS refusal (403) reaches the caller as 403 with the OS reason, not as success', async () => {
  const os = fakeOs({ 'GET /api/auth/me': ALICE, 'POST /api/apps/by-slug/orders/records': { status: 403, json: { error: 'envelope does not permit writes' } } });
  try {
    const res = await addOrder(req({ amount: 50 }));
    assert.equal(res.status, 403);
    assert.match(JSON.stringify(await res.json()), /envelope does not permit writes/);
  } finally { os.restore(); }
});

test('no session means 401 and nothing is written', async () => {
  const os = fakeOs({ 'GET /api/auth/me': { json: { user: null } } });
  try {
    const res = await addOrder(req({ amount: 50 }, ''));
    assert.equal(res.status, 401);
    assert.ok(!os.calls.some((c) => c.method === 'POST'));
  } finally { os.restore(); }
});

test('an invalid body is 400 before any OS call', async () => {
  const os = fakeOs({});
  try {
    assert.equal((await addOrder(req({ amount: 'x' }))).status, 400);
    assert.equal(os.calls.length, 0);
  } finally { os.restore(); }
});

test('an agent run held for approval is returned as parked, never as an answer', async () => {
  const os = fakeOs({
    'GET /api/auth/me': ALICE,
    'POST /api/agents/systems/review/run': { json: { runId: 'r1', parked: true, approvalId: 'ap1' } },
  });
  try {
    const res = await ask(req({ systemId: 'review', message: 'check order 7' }));
    const out = (await res.json()) as { state: string; approvalId?: string };
    assert.equal(res.status, 200);
    assert.equal(out.state, 'parked');
    assert.equal(out.approvalId, 'ap1');
  } finally { os.restore(); }
});

test('a bearer token issued by the OS is forwarded too, so identity works without a shared cookie', async () => {
  const os = fakeOs({ 'GET /api/auth/me': ALICE, 'POST /api/apps/by-slug/orders/records': { json: { result: { ok: true } } } });
  try {
    const res = await addOrder(new Request('http://app/x', { method: 'POST', headers: { authorization: 'Bearer t1' }, body: JSON.stringify({ amount: 1 }) }));
    assert.equal(res.status, 201);
    assert.ok(os.calls.every((c) => c.authorization === 'Bearer t1'));
  } finally { os.restore(); }
});

test('without OS_BASE_URL the app says so (502), it does not pretend', async () => {
  const os = fakeOs({});
  delete process.env.OS_BASE_URL;
  try {
    const res = await addOrder(req({ amount: 5 }));
    assert.equal(res.status, 502);
    assert.match(JSON.stringify(await res.json()), /OS_BASE_URL/);
  } finally { os.restore(); }
});
