/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The one secret scrubber — by value and by key name — for traces, cards and repo reads
 * USER STORY: As an auditor I never want to find a credential in a trace, an approval card or an
 *             error message, and I want ordinary fields (token counts, page cursors, project keys)
 *             left readable.
 * ARCHITECTURE: pure functions (`core/infra/trace-masking.ts`). Each positive case has a negative
 *             twin that must NOT be replaced.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REDACTED, isSecretKeyName, maskExportedAttribute, maskFlatAttributes, redactSecrets, redactSecretText, scrubSecrets } from '@core/infra/trace-masking';
import { scrubSecrets as gitScrub } from '@core/infra/git-store';

const has = (text: string, secret: string) => text.includes(secret);

test('by value: bearer/basic headers, GitHub, OpenAI, Slack, JWT, AWS, URL userinfo, PEM are redacted', () => {
  const cases: [string, string][] = [
    ['Authorization: Bearer abcdefgh12345678xyz', 'abcdefgh12345678xyz'],
    ['Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA=='],
    [`token ghp_${'A1'.repeat(15)}`, `ghp_${'A1'.repeat(15)}`],
    [`github_pat_${'x'.repeat(30)}`, `github_pat_${'x'.repeat(30)}`],
    [`key sk-proj-${'k'.repeat(30)}`, `sk-proj-${'k'.repeat(30)}`],
    ['slack xoxb-1234567890-abcdefghij', 'xoxb-1234567890-abcdefghij'],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0'],
    ['aws AKIAIOSFODNN7EXAMPLE and ASIAIOSFODNN7EXAMPLE', 'IOSFODNN7EXAMPLE'],
    ['connect to postgres://svc:p4ssw0rd@db.internal:5432/x failed', 'p4ssw0rd'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----', 'MIIEow'],
  ];
  for (const [text, secret] of cases) {
    const out = redactSecretText(text);
    assert.ok(!has(out, secret), `${text} → ${out}`);
    assert.ok(out.includes(REDACTED), out);
  }
  // The scheme and user of a URL stay — only the password goes.
  assert.equal(redactSecretText('postgres://svc:p4ss@db/x'), `postgres://svc:${REDACTED}@db/x`);
});

test('by value TWIN: a sha, a UUID, a plain sentence and a URL without a password are untouched', () => {
  for (const t of ['commit 3f2a9c1b7e4d5a6b8c9d0e1f2a3b4c5d6e7f8a9b', 'id 123e4567-e89b-12d3-a456-426614174000', 'Basic plan costs 10', 'https://example.com/a@b']) {
    assert.equal(scrubSecrets(t).redactions, 0, t);
  }
});

test('by key name: whole words — secrets are caught, ordinary fields are not over-redacted', () => {
  for (const k of ['password', 'PASSWORD', 'db_password', 'pwd', 'passphrase', 'clientSecret', 'client_secret', 'secret', 'apiKey', 'api_key', 'accessKey', 'privateKey', 'secret_access_key',
    'accessToken', 'access_token', 'refresh_token', 'token', 'authToken', 'auth', 'Authorization', 'jwt', 'pat', 'github_pat', 'dsn', 'credential', 'credentials', 'cookie', 'set-cookie', 'session', 'sessionId', 'connection_string']) {
    assert.equal(isSecretKeyName(k), true, k);
  }
  for (const k of ['max_tokens', 'maxTokens', 'tokenizer', 'token_count', 'tokenType', 'page_token', 'pageToken', 'nextPageToken', 'next_token', 'bypass', 'authType', 'author', 'projectKey', 'key', 'issueKey', 'pattern', 'sessions_count', 'dagId', 'description']) {
    assert.equal(isSecretKeyName(k), false, k);
  }
});

test('redactSecrets: deep, never mutates; values of secret keys and secret-shaped strings both go', () => {
  const v = { a: { password: 'x1', nested: [{ note: 'Bearer abcdefgh12345678' }] }, max_tokens: 512, page_token: 'cursor-2', projectKey: 'OPS' };
  const out = redactSecrets(v);
  assert.deepEqual(out, { a: { password: REDACTED, nested: [{ note: `Bearer ${REDACTED}` }] }, max_tokens: 512, page_token: 'cursor-2', projectKey: 'OPS' });
  assert.equal(v.a.password, 'x1');
});

test('one scrubber: git-store re-exports the same function (repository reads redact the same shapes)', () => {
  assert.equal(gitScrub, scrubSecrets);
});

test('content masking: the attribution keys stay readable but are STILL PII-scrubbed (an e-mail id is replaced)', () => {
  const data = JSON.stringify({ actingUser: 'carl@acme.com', credentialSubject: 'olga', credentialMode: 'owner', connectionId: 'c1', note: 'free text' });
  const out = JSON.parse(maskExportedAttribute(data, { enabled: true, level: 'content' }) as string);
  assert.equal(out.actingUser, '[email]', 'structural, yet the PII scrub still applies');
  assert.equal(out.credentialSubject, 'olga');
  assert.equal(out.credentialMode, 'owner');
  assert.deepEqual(out.note, { redacted: true, chars: 9 }, 'free text is reduced to its size');
  const flat: Record<string, unknown> = { 'langfuse.observation.metadata.actingUser': 'carl@acme.com' };
  maskFlatAttributes(flat, { enabled: true, level: 'content' });
  assert.equal(flat['langfuse.observation.metadata.actingUser'], '[email]');
});
