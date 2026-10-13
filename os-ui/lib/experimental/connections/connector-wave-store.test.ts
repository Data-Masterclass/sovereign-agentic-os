/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Store-level DoD coverage for the connector wave (GitHub / Supabase / Notion /
 * Atlassian): the five non-negotiables through the governed `callConnectionTool`
 * path — write-only secret, unseeable id → not_found, reads auto / writes held /
 * deletes blocked — plus the executor-registry dispatch reaching the real client
 * (mocked via a scripted global fetch) instead of the offline mock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Stub fetch BEFORE importing the store so getCache() initialises an empty offline Map.
const _realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const {
  createConnection,
  callConnectionTool,
  getConnectionForUser,
  __resetConnections,
} = await import('./store.ts');
const { resolveGithub } = await import('./github.ts');
const { resolveSupabase } = await import('./supabase.ts');
const { resolveAtlassian } = await import('./atlassian.ts');
const { hasSecret, getSecretServerSide } = await import('@/lib/infra/secrets');
const { CONNECTION_TEMPLATES, USER_FACING_TEMPLATE_KEYS } = await import('./schema.ts');
const { installGuideFor } = await import('./install-guides.ts');

const builder = { id: 'b1', name: 'B', domains: ['eng'], role: 'builder' as const };
const stranger = { id: 's1', name: 'S', domains: ['other'], role: 'builder' as const };

/** Script the global fetch for one call, capturing the request. */
function scriptFetch(handler: (url: string, init: RequestInit) => { status: number; body?: unknown; headers?: Record<string, string> }) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    const r = handler(u, init ?? {});
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: new Headers(r.headers ?? {}),
      json: async () => r.body ?? {},
      text: async () => JSON.stringify(r.body ?? {}),
    } as Response;
  }) as typeof fetch;
  return calls;
}

test('templates: github / supabase / atlassian are registered AND user-facing (in gallery + wizard)', () => {
  for (const key of ['github', 'supabase', 'atlassian'] as const) {
    assert.ok(CONNECTION_TEMPLATES.some((t) => t.key === key), `${key} template row exists`);
    assert.ok((USER_FACING_TEMPLATE_KEYS as string[]).includes(key), `${key} is user-facing`);
    assert.ok(installGuideFor(key), `${key} has an install guide`);
  }
});

test('secret is WRITE-ONLY: the credential is vaulted, never on the serialized record', async () => {
  __resetConnections();
  const c = await createConnection(builder, { name: 'gh', template: 'github', endpoint: 'https://api.github.com', credential: 'ghp_super_secret_xxx' });
  assert.ok(hasSecret(c.secretRef), 'credential written to Secrets Manager');
  assert.equal(getSecretServerSide(c.secretRef), 'ghp_super_secret_xxx');
  // The raw secret must NEVER appear in the record JSON — only a ref + fingerprint.
  assert.ok(!JSON.stringify(c).includes('ghp_super_secret_xxx'), 'secret absent from the record');
  assert.ok(c.secretFingerprint.startsWith('sha256:'));
});

test('unseeable id → not_found (no existence leak) across all three resolvers', async () => {
  __resetConnections();
  const c = await createConnection(builder, { name: 'gh', template: 'github', endpoint: 'https://api.github.com', credential: 'ghp_x' });
  // Owner (builder in domain) can resolve it.
  assert.equal((await resolveGithub(c.id, builder)).id, c.id);
  // A stranger in another domain gets a 404 — never a "wrong type"/existence signal.
  await assert.rejects(() => resolveGithub(c.id, stranger), /not found/i);
  await assert.rejects(() => getConnectionForUser(c.id, stranger), /not found/i);
});

test('resolvers reject the WRONG template type (400), not a data leak', async () => {
  __resetConnections();
  const gh = await createConnection(builder, { name: 'gh', template: 'github', endpoint: 'https://api.github.com', credential: 'ghp_x' });
  await assert.rejects(() => resolveSupabase(gh.id, builder), /Not a Supabase/);
  await assert.rejects(() => resolveAtlassian(gh.id, builder), /Not an Atlassian/);
});

test('GitHub: a READ auto-allows and the executor reaches the REAL API (not the mock)', async () => {
  __resetConnections();
  const c = await createConnection(builder, { name: 'gh', template: 'github', endpoint: 'https://api.github.com', credential: 'ghp_x' });
  const calls = scriptFetch(() => ({ status: 200, body: [{ full_name: 'acme/api', private: false }] }));
  const r = await callConnectionTool(c.id, builder, { tool: 'list_repos' });
  assert.equal(r.decision, 'allow');
  const result = r.result as { repos?: { fullName: string }[] };
  assert.ok(result.repos && result.repos[0].fullName === 'acme/api', 'real client shape, not the mock');
  assert.ok(calls.some((x) => x.url.includes('api.github.com/user/repos')), 'hit the real GitHub API');
  // The vaulted token was injected server-side as the bearer — and never echoed back.
  assert.ok(!JSON.stringify(r).includes('ghp_x'), 'secret never in the tool result');
  globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;
});

test('GitHub: a WRITE is HELD for approval (create_issue), never auto-run', async () => {
  __resetConnections();
  const c = await createConnection(builder, { name: 'gh', template: 'github', endpoint: 'https://api.github.com', credential: 'ghp_x' });
  let issuePosted = false;
  // Only count a POST to the GitHub issues endpoint — the write itself (ignore any
  // audit-trace egress the store may emit).
  scriptFetch((url, init) => { if (init.method === 'POST' && url.includes('github.com') && url.includes('/issues')) issuePosted = true; return { status: 200, body: [] }; });
  const r = await callConnectionTool(c.id, builder, { tool: 'create_issue', args: { repo: 'acme/api', title: 'bug' } });
  assert.equal(r.decision, 'requires_approval', 'write is held, not executed');
  assert.ok(!issuePosted, 'no issue POST happened — the write did not run');
  globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;
});

test('GitHub: a DELETE is BLOCKED (deny) by default', async () => {
  __resetConnections();
  const c = await createConnection(builder, { name: 'gh', template: 'github', endpoint: 'https://api.github.com', credential: 'ghp_x' });
  const r = await callConnectionTool(c.id, builder, { tool: 'delete_repo', args: { repo: 'acme/api' } });
  assert.equal(r.decision, 'deny');
});

test('Supabase: execute_sql is held (Write-approval); apply_migration is Blocked', async () => {
  __resetConnections();
  const c = await createConnection(builder, { name: 'sb', template: 'supabase', endpoint: 'https://api.supabase.com', credential: 'sbp_x' });
  const held = await callConnectionTool(c.id, builder, { tool: 'execute_sql', args: { ref: 'abcdefghijklmnopqrst', sql: 'select 1' } });
  assert.equal(held.decision, 'requires_approval');
  const blocked = await callConnectionTool(c.id, builder, { tool: 'apply_migration', args: { ref: 'abcdefghijklmnopqrst' } });
  assert.equal(blocked.decision, 'deny');
});

test('Atlassian: a read auto-allows and reaches Jira; a delete is Blocked', async () => {
  __resetConnections();
  const c = await createConnection(builder, { name: 'jira', template: 'atlassian', endpoint: 'https://acme.atlassian.net', credential: 'tok', atlassian: { authKind: 'basic', email: 'me@acme.com' } });
  const calls = scriptFetch(() => ({ status: 200, body: { total: 0, issues: [] } }));
  const r = await callConnectionTool(c.id, builder, { tool: 'jira_search_issues', args: { jql: 'project = ACME' } });
  assert.equal(r.decision, 'allow');
  assert.ok(calls.some((x) => x.url.includes('acme.atlassian.net/rest/api/3/search')));
  globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;
  const del = await callConnectionTool(c.id, builder, { tool: 'jira_delete_issue', args: { key: 'ACME-1' } });
  assert.equal(del.decision, 'deny');
});

test('restore the real fetch', () => {
  globalThis.fetch = _realFetch;
});
