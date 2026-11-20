// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// Test helpers for the lakehouse harness. Trino's client REST protocol as documented in
// https://trino.io/docs/476/develop/client-protocol.html: POST /v1/statement, follow nextUri,
// DELETE nextUri to cancel. No Trino behaviour is re-implemented here; the tests only drive
// the protocol and read Trino's own answers (system.runtime.queries, /v1/query/{id}).

export const TRINO = process.env.LH_TRINO_URL ?? `http://127.0.0.1:${process.env.LH_TRINO_PORT ?? '18080'}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The headers a client sends. `source` and `tags` are the scheduling inputs under test. */
export function headers({ user, source, tags, principal } = {}) {
  const h = { 'X-Trino-User': user ?? 'lh-observer', 'Content-Type': 'text/plain' };
  if (source !== undefined) h['X-Trino-Source'] = source;
  if (tags) h['X-Trino-Client-Tags'] = tags.join(',');
  if (principal) h.Authorization = `Basic ${Buffer.from(`${principal}:`).toString('base64')}`;
  return h;
}

async function json(res, what) {
  const text = await res.text();
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/** Run a statement to completion and return its rows. Throws on a Trino error. */
export async function run(sql, opts = {}) {
  const h = headers(opts);
  let r = await json(await fetch(`${TRINO}/v1/statement`, { method: 'POST', headers: h, body: sql }), 'POST /v1/statement');
  const rows = [];
  while (true) {
    if (r.error) throw new Error(`Trino: ${r.error.message}`);
    if (r.data) rows.push(...r.data);
    if (!r.nextUri) return { id: r.id, rows };
    r = await json(await fetch(r.nextUri, { headers: h }), 'GET nextUri');
  }
}

/** Rows of system.runtime.queries for these ids, read by a separate observer. */
export async function queries(ids) {
  const list = ids.map((i) => `'${i}'`).join(',');
  const { rows } = await run(
    `SELECT query_id, state, "user", source, resource_group_id FROM system.runtime.queries WHERE query_id IN (${list})`,
    { user: 'lh-observer', source: 'lh-observer' },
  );
  return Object.fromEntries(rows.map(([id, state, user, source, rg]) => [id, { state, user, source, rg: rg?.join('.') ?? null }]));
}

/**
 * Start a query that stays RUNNING until cancelled: a 10^8-row result the client stops reading,
 * so Trino's output buffer fills and the query holds its slot. Returns once Trino has dispatched
 * it (it has a query id and a state), whether that state is RUNNING or QUEUED.
 */
export async function hold(opts) {
  const sql = 'SELECT a.x, b.y FROM UNNEST(sequence(1, 10000)) a(x) CROSS JOIN UNNEST(sequence(1, 10000)) b(y)';
  const h = headers(opts);
  let r = await json(await fetch(`${TRINO}/v1/statement`, { method: 'POST', headers: h, body: sql }), 'POST /v1/statement');
  for (let i = 0; i < 100; i++) {
    if (r.error) throw new Error(`Trino: ${r.error.message}`);
    const state = r.stats?.state;
    if (state === 'RUNNING' || (state === 'QUEUED' && i > 3)) break;
    if (!r.nextUri) throw new Error(`query finished before it could be held (${state})`);
    r = await json(await fetch(r.nextUri, { headers: h }), 'GET nextUri');
    if (state === 'QUEUED') await sleep(200);
  }
  const next = r.nextUri;
  return {
    id: r.id,
    cancel: async () => { if (next) await fetch(next, { method: 'DELETE', headers: h }); },
  };
}

/** Poll until `pred(rowsById)` holds, or fail with the last observation. */
export async function until(ids, pred, what, ms = 30000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await queries(ids);
    if (pred(last)) return last;
    await sleep(500);
  }
  throw new Error(`${what}: not reached in ${ms} ms; last ${JSON.stringify(last)}`);
}

/** QueryInfo, Trino's own record of the session (system properties, client tags, source). */
export async function info(id) {
  return json(await fetch(`${TRINO}/v1/query/${id}`, { headers: headers() }), `GET /v1/query/${id}`);
}
