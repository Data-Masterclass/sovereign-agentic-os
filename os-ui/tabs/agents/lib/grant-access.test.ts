/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Tell the builder, when they save or build, which granted resources they cannot use
 * USER STORY: As a student who granted a dataset that is private to another user I want to be
 *             told so on save — and told nothing else about that dataset.
 * ARCHITECTURE:
 *   - Part 1 pins the PURE classifier (`grant-access.ts`) with a scripted probe: every verdict,
 *     the folder rule, Off/Blocked grants, a throwing probe, and the no-leak wording.
 *   - Part 2 runs the REAL governed door (`build/grant-access-probe.ts` → `handleRpc` →
 *     `get_dataset` → the Data tab's own canView): datasets are created by two users with the
 *     MCP tool a user would call, and the check runs as the student. No store is mocked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { checkGrantAccess, classifyProbe, grantAccessMessage, grantWarningKey } = await import('./grant-access.ts');
const { parseSystem } = await import('@tabs/agents/lib/system-schema');
type ProbeResult = import('./grant-access.ts').ProbeResult;

function sys(grants: string, domain = 'sales') {
  return parseSystem(
    [
      `system: { name: t, domain: ${domain}, visibility: Personal }`,
      'entrypoint: a',
      `grants: { ${grants} }`,
      'agents: [{ id: a, role: reads }]',
    ].join('\n'),
  );
}

const student = { domains: ['sales'] };

/** A probe answering from a fixed table (what each tab's canView would say to the student). */
function scripted(table: Record<string, ProbeResult>) {
  return async (_kind: string, id: string): Promise<ProbeResult> => table[id] ?? { status: 'not_found' };
}

// ------------------------------------------------------------------ part 1 --

test('private dataset of ANOTHER owner ⇒ not-visible, with the actionable sentence', async () => {
  const w = await checkGrantAccess(student, sys('data: [{ id: ds_theirs, capability: Read }]'), scripted({ ds_theirs: { status: 'forbidden' } }));
  assert.equal(w.length, 1);
  assert.equal(w[0].status, 'not-visible');
  assert.equal(w[0].id, 'ds_theirs');
  assert.match(w[0].message, /You can't see this dataset — it is private to its owner or not shared with your domain\. Ask the owner to share it to the sales domain\./);
});

test('own private dataset ⇒ ok (no warning)', async () => {
  const w = await checkGrantAccess(student, sys('data: [{ id: ds_mine, capability: Read }]'), scripted({ ds_mine: { status: 'visible', domain: 'sales' } }));
  assert.deepEqual(w, []);
});

test('a dataset shared to the team’s OWN domain ⇒ ok', async () => {
  const w = await checkGrantAccess(student, sys('data: [{ id: ds_shared, capability: Read }]'), scripted({ ds_shared: { status: 'visible', domain: 'sales' } }));
  assert.deepEqual(w, []);
});

test('a dataset shared to ANOTHER domain the student is not in ⇒ not-visible (canView refuses)', async () => {
  const w = await checkGrantAccess(student, sys('data: [{ id: ds_fin, capability: Read }]'), scripted({ ds_fin: { status: 'forbidden' } }));
  assert.equal(w[0].status, 'not-visible');
});

test('visible but homed in another domain than the team ⇒ outside-domain; marketplace + domainless stay ok', async () => {
  const w = await checkGrantAccess(
    { domains: ['sales', 'finance'] },
    sys('data: [{ id: ds_fin, capability: Read }, { id: ds_mkt, capability: Read }, { id: ds_free, capability: Read }]'),
    scripted({
      ds_fin: { status: 'visible', domain: 'finance' },
      ds_mkt: { status: 'visible', domain: 'finance', marketplace: true },
      ds_free: { status: 'visible', domain: '' },
    }),
  );
  assert.deepEqual(w.map((x) => [x.id, x.status]), [['ds_fin', 'outside-domain']]);
});

test('an id that does not exist ⇒ not-found', async () => {
  const w = await checkGrantAccess(student, sys('knowledge: [{ id: pk_gone, capability: Read }]'), scripted({}));
  assert.equal(w[0].status, 'not-found');
  assert.equal(w[0].kind, 'knowledge');
  assert.match(w[0].message, /No knowledge note with this id exists that you can see/);
});

test('every kind is checked: workflows, metrics, connections, files', async () => {
  const seen: string[] = [];
  await checkGrantAccess(
    student,
    sys('workflows: [{ id: wf_1, capability: Read }], metrics: [{ id: ds_1.rev, capability: Read }], connections: [{ id: conn_1, capability: Read }], files: [{ id: as_1, capability: Read }], tools: []'),
    async (kind, id) => { seen.push(`${kind}:${id}`); return { status: 'visible' }; },
  );
  assert.deepEqual(seen.sort(), ['connections:conn_1', 'files:as_1', 'metrics:ds_1.rev', 'workflows:wf_1']);
});

test('Off / Blocked grants are not probed; an outage (unknown / throw) says nothing', async () => {
  let calls = 0;
  const w = await checkGrantAccess(
    student,
    sys('data: [{ id: ds_off, capability: Off }, { id: ds_blk, capability: Blocked }, { id: ds_x, capability: Read }, { id: ds_y, capability: Read }]'),
    async (_k, id) => { calls++; if (id === 'ds_x') throw new Error('down'); return { status: 'unknown' }; },
  );
  assert.deepEqual(w, []);
  assert.equal(calls, 2);
});

test('folder grants: personal ⇒ ok; a Domain folder of a domain you are not in ⇒ not-visible', async () => {
  const s = sys('files: [{ folder: { path: /reports, scope: domain }, capability: Read }, { folder: { path: /mine, scope: personal }, capability: Read }], data: [], knowledge: [], tools: [], connections: []');
  assert.deepEqual(await checkGrantAccess(student, s, scripted({})), []);
  const outsider = await checkGrantAccess({ domains: ['finance'] }, s, scripted({}));
  assert.equal(outsider.length, 1);
  assert.equal(outsider[0].status, 'not-visible');
  assert.equal(grantWarningKey(outsider[0]), 'files:folder:domain:/reports');
  assert.match(outsider[0].message, /you are not a member of the sales domain/);
});

test('NO LEAK: a not-visible message is built from the kind and the TEAM’s domain only', () => {
  // The classifier never receives the hidden resource's name, owner or home domain — prove the
  // sentence for each status is a pure function of (kind, status, team domain).
  for (const status of ['not-visible', 'not-found'] as const) {
    const m = grantAccessMessage('data', status, 'sales');
    assert.doesNotMatch(m, /kenji|finance|Finance Secret/);
  }
  assert.equal(classifyProbe({ status: 'forbidden' }, 'sales'), 'not-visible');
});

// ------------------------------------------------------------------ part 2 --

const { handleRpc } = await import('@core/mcp/server');
const { grantWarningsFor, readProbeAnswer } = await import('./build/grant-access-probe.ts');

const amir = { id: 'amir_ga', name: 'Amir', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'creator' as const };
const kenji = { id: 'kenji_ga', name: 'Kenji', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'creator' as const };

async function createDataset(user: typeof amir, name: string): Promise<string> {
  const res = (await handleRpc(user, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_dataset', arguments: { name } } })) as { result: { isError?: boolean; content: { text: string }[] } };
  assert.notEqual(res.result.isError, true, res.result.content?.[0]?.text);
  const r = JSON.parse(res.result.content[0].text) as Record<string, unknown>;
  return String((r.dataset as { id?: string } | undefined)?.id ?? r.id ?? r.datasetId);
}

test('REAL DOOR: another user’s PRIVATE dataset is not-visible; my own is fine; a made-up id is not-found', async () => {
  const theirs = await createDataset(kenji, 'Kenji private orders');
  const mine = await createDataset(amir, 'Amir own orders');
  const s = sys(`data: [{ id: ${theirs}, capability: Read }, { id: ${mine}, capability: Read }, { id: ds_doesnotexist0, capability: Read }]`);
  const w = await grantWarningsFor(amir, s);
  const byId = Object.fromEntries(w.map((x) => [x.id, x.status]));
  assert.equal(byId[theirs], 'not-visible', JSON.stringify(w));
  assert.equal(byId[mine], undefined, 'own private dataset is ok');
  assert.equal(byId.ds_doesnotexist0, 'not-found');
  // No leak: nothing about Kenji's dataset reaches Amir — not its name, not its owner.
  const text = JSON.stringify(w);
  assert.doesNotMatch(text, /Kenji private orders/);
  assert.doesNotMatch(text, /kenji_ga/);
});

test('MCP: create_agent_system / commit_agent_files / build_agent_system carry the same typed grantWarnings', async () => {
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = (await handleRpc(amir, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as { result: { isError?: boolean; content: { text: string }[] } };
    assert.notEqual(res.result.isError, true, `${name}: ${res.result.content?.[0]?.text}`);
    return JSON.parse(res.result.content[0].text) as Record<string, unknown>;
  };
  const theirs = await createDataset(kenji, 'Kenji secret orders');
  const created = await call('create_agent_system', { name: 'Student via MCP' });
  assert.deepEqual(created.grantWarnings, [], 'a blank system has nothing to warn about');
  const yaml = (await import('@tabs/agents/lib/store')).readFile(String(created.id), amir, 'system.yaml').content;
  const next = parseSystem(yaml);
  next.grants.data = [{ id: theirs, capability: 'Read' }];
  const { serializeSystem } = await import('@tabs/agents/lib/system-schema');
  const committed = await call('commit_agent_files', { systemId: created.id, path: 'system.yaml', content: serializeSystem(next) });
  const ws = committed.grantWarnings as { id: string; status: string; message: string }[];
  assert.equal(ws.length, 1);
  assert.equal(ws[0].id, theirs);
  assert.equal(ws[0].status, 'not-visible');
  assert.doesNotMatch(JSON.stringify(committed), /Kenji secret orders|kenji_ga/);
  // An AGENT.md-only commit carries no grantWarnings field at all.
  const md = await call('commit_agent_files', { systemId: created.id, path: `agents/${next.agents[0].id}/AGENT.md`, content: '# hi' });
  assert.equal(md.grantWarnings, undefined);
});

test('readProbeAnswer: typed errors map, an outage is unknown, a certified body is marketplace', () => {
  const err = (code: string) => ({ jsonrpc: '2.0', id: 1, result: { isError: true, structuredContent: { error: { code } }, content: [] } });
  assert.deepEqual(readProbeAnswer(err('forbidden')), { status: 'forbidden' });
  assert.deepEqual(readProbeAnswer(err('not_found')), { status: 'not_found' });
  assert.deepEqual(readProbeAnswer(err('upstream_error')), { status: 'unknown' });
  assert.deepEqual(readProbeAnswer(null), { status: 'unknown' });
  const ok = { jsonrpc: '2.0', id: 1, result: { content: [{ text: JSON.stringify({ domain: 'finance', tier: 'product' }) }] } };
  assert.deepEqual(readProbeAnswer(ok), { status: 'visible', domain: 'finance', marketplace: true });
});
