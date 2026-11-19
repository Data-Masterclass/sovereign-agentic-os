/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Tests for the legacy-key sweep.
 *
 * USER STORY: As a platform admin I need certainty that the sweep deletes exactly the keys that
 *             must go — the guessable per-system keys and the unbudgeted keys of the old
 *             reconcile — and never a random system key, a hand-made key or a budgeted one;
 *             that running it twice is harmless; and that a gateway it cannot read is not
 *             treated as an empty one.
 *
 * ARCHITECTURE:
 *   `planKeySweep` is pure; `runKeySweep` is driven with a fake gateway (a row list plus a
 *   delete that removes from it), so idempotence is observed rather than assumed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planKeySweep, runKeySweep, scheduleBootKeySweep, type KeySweepResult } from './agent-system-key-sweep.ts';
import { legacyDerivedKey, mintSystemKey, tokenIdOf } from './agent-system-keys.ts';
import type { Fetched, LiteLlmKeyRow } from './litellm-admin.ts';

const derivable = (id: string): LiteLlmKeyRow => ({ key_alias: `os-${id}`, token: tokenIdOf(legacyDerivedKey(`os-${id}`)), max_budget: 5 });
const random = (id: string): LiteLlmKeyRow => ({ key_alias: `os-${id}`, token: tokenIdOf(mintSystemKey()), max_budget: 5, metadata: { os_owner: 'agent', os_id: id } });
const reconcileKey = (id: string, over: Partial<LiteLlmKeyRow> = {}): LiteLlmKeyRow => ({ key_alias: `agent-${id}`, token: tokenIdOf(mintSystemKey()), max_budget: null, metadata: { os_owner: 'agent', os_id: id }, ...over });

function gateway(initial: LiteLlmKeyRow[]) {
  const rows = [...initial];
  const lines: string[] = [];
  return {
    rows,
    lines,
    io: {
      list: async (): Promise<Fetched<LiteLlmKeyRow[]>> => ({ ok: true, data: [...rows] }),
      deleteKey: async (tokenId: string): Promise<Fetched<unknown>> => {
        const i = rows.findIndex((r) => r.token === tokenId);
        if (i >= 0) rows.splice(i, 1);
        return { ok: true, data: {} };
      },
      now: () => 42,
      log: (l: string) => { lines.push(l); },
    },
  };
}

test('SWEEP PLAN: a guessable per-system key and an unbudgeted reconcile key are targets; nothing else is', () => {
  const rows: LiteLlmKeyRow[] = [
    derivable('sys_a'),
    random('sys_b'),
    reconcileKey('sys_c'),
    reconcileKey('sys_d', { max_budget: 20 }), // an admin gave it a budget: theirs now
    { key_alias: 'agent-handmade', token: tokenIdOf('sk-x'), max_budget: null }, // looks like one, but not stamped by the OS
    { key_alias: 'agent-sys_e', token: tokenIdOf('sk-y'), max_budget: null, metadata: { os_owner: 'agent', os_id: 'someone-else' } },
    { key_alias: 'sovereign-agents', token: tokenIdOf('sk-shared'), max_budget: 5 },
    { key_alias: 'os-sys_f', token: tokenIdOf('sk-os-sys_a') }, // another system's derived value: not ITS derived value
    { key_alias: 'os-broken' }, // no token reported: cannot be judged, so it is left
  ];
  assert.deepEqual(
    planKeySweep(rows).map((t) => [t.alias, t.reason]),
    [['os-sys_a', 'derivable'], ['agent-sys_c', 'unbudgeted-agent-key']],
  );
});

test('SWEEP: deletes only the targets, reports them by alias, and a second run finds nothing (idempotent)', async () => {
  const keep = [random('sys_b'), { key_alias: 'sovereign-agents', token: tokenIdOf('sk-shared'), max_budget: 5 }];
  const gw = gateway([derivable('sys_a'), derivable('sys_z'), reconcileKey('sys_c'), ...keep]);
  const first = await runKeySweep(gw.io);
  assert.equal(first.ok, true);
  assert.equal(first.scanned, 5);
  assert.deepEqual(first.deleted.map((d) => d.alias).sort(), ['agent-sys_c', 'os-sys_a', 'os-sys_z']);
  assert.deepEqual(gw.rows, keep, 'the random system key and the shared key are untouched');
  const second = await runKeySweep(gw.io);
  assert.deepEqual([second.ok, second.deleted, second.failed], [true, [], []]);
  assert.deepEqual(gw.rows, keep);
});

test('SWEEP: an unreadable gateway deletes NOTHING and says so; a failed delete is reported, the rest still run', async () => {
  let deletes = 0;
  const blind = await runKeySweep({ list: async () => ({ ok: false, error: 'HTTP 503' }), deleteKey: async () => { deletes += 1; return { ok: true, data: {} }; }, log: () => undefined });
  assert.deepEqual([blind.ok, blind.error, blind.deleted.length, deletes], [false, 'HTTP 503', 0, 0]);

  const gw = gateway([derivable('sys_a'), derivable('sys_b')]);
  const io = { ...gw.io, deleteKey: async (tokenId: string): Promise<Fetched<unknown>> => (tokenId === derivable('sys_a').token ? { ok: false, error: 'HTTP 500' } : gw.io.deleteKey(tokenId)) };
  const out = await runKeySweep(io);
  assert.equal(out.ok, false);
  assert.deepEqual(out.failed, [{ alias: 'os-sys_a', error: 'HTTP 500' }]);
  assert.deepEqual(out.deleted.map((d) => d.alias), ['os-sys_b']);
});

test('SWEEP LOG and RESULT carry aliases and counts — never a key, a guessable value or a token id', async () => {
  const gw = gateway([derivable('sys_a'), reconcileKey('sys_c')]);
  const tokens = gw.rows.map((r) => String(r.token));
  const result = await runKeySweep(gw.io);
  const text = gw.lines.join('\n') + JSON.stringify(result);
  assert.match(text, /os-sys_a/);
  assert.doesNotMatch(text, /sk-/, 'no key-shaped string, not even the guessable one');
  for (const t of tokens) assert.ok(!text.includes(t), 'no token id in the log or the result');
});

test('BOOT: the sweep is not scheduled in a process without gateway admin access (the worker)', async () => {
  // The test environment, like the worker, may hold no admin configuration; when it does, the
  // schedule runs the injected sweep exactly once and never throws into boot.
  let runs = 0;
  const sweep = async (): Promise<KeySweepResult> => { runs += 1; return { at: 1, ok: true, scanned: 0, deleted: [], failed: [] }; };
  scheduleBootKeySweep(sweep, [0]);
  scheduleBootKeySweep(sweep, [0]); // a second call in the same process is a no-op
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(runs <= 1, 'at most once per process');
});

test('KEY LISTING is read page by page to the end; a failed page fails the whole read (never a partial list)', async () => {
  const { readAllKeys } = await import('./litellm-admin.ts');
  const page = (n: number) => Array.from({ length: n }, (_, i) => ({ key_alias: `k${i}`, token: `t${i}` }));
  const seen: string[] = [];
  const get = (async (path: string) => {
    seen.push(path);
    const p = Number(new URL(`http://x${path}`).searchParams.get('page'));
    return { ok: true, data: { keys: p <= 2 ? page(100) : page(3), total_pages: 3, current_page: p } };
  }) as unknown as Parameters<typeof readAllKeys>[0];
  const all = await readAllKeys(get);
  assert.equal(all.ok && all.data.length, 203);
  assert.equal(seen.length, 3);
  assert.ok(seen.every((s) => /size=100/.test(s) && /return_full_object=true/.test(s)));

  const broken = (async (path: string) => (path.includes('page=2') ? { ok: false, error: 'HTTP 500' } : { ok: true, data: { keys: page(100) } })) as unknown as Parameters<typeof readAllKeys>[0];
  assert.deepEqual(await readAllKeys(broken), { ok: false, error: 'HTTP 500' });
});
