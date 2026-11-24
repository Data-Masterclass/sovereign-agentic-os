/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The one secret scrubber — by value and by key name — for traces, cards, chat errors and repo reads
 * USER STORY: As an auditor I never want to find a credential in a trace, an approval card or an
 *             error message, and I want ordinary fields (token counts, page cursors, project keys,
 *             the OS's own attribution) left readable.
 * ARCHITECTURE: pure functions (`core/infra/trace-masking.ts`). Each positive case has a negative
 *             twin that must NOT be replaced. Includes the independent verifier's probe cases.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REDACTED, REDACT_MAX_DEPTH, isSecretKeyName, maskExportedAttribute, maskFlatAttributes, redactSecrets, redactSecretText, scrubSecrets } from '@core/infra/trace-masking';
import { scrubSecrets as gitScrub } from '@core/infra/git-store';

const SECRET = 'Zq9-probe-secret-value';
const leaks = (v: unknown) => {
  const out = JSON.stringify(redactSecrets(v));
  return out.includes(SECRET) || out.includes('sk_live_') || out.includes('aaaaaaaaaaaaaaaa');
};

test('by value: bearer/basic headers, GitHub, OpenAI, Stripe, Slack, JWT, AWS, URL userinfo, PEM are redacted', () => {
  const cases: [string, string][] = [
    ['Authorization: Bearer abcdefgh12345678xyz', 'abcdefgh12345678xyz'],
    ['authorization: bearer abcdefgh12345678xyz', 'abcdefgh12345678xyz'],
    ['Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA=='],
    [`token ghp_${'A1'.repeat(15)}`, `ghp_${'A1'.repeat(15)}`],
    [`github_pat_${'x'.repeat(30)}`, `github_pat_${'x'.repeat(30)}`],
    [`key sk-proj-${'k'.repeat(30)}`, `sk-proj-${'k'.repeat(30)}`],
    [`stripe sk_live_${'a'.repeat(24)}`, `sk_live_${'a'.repeat(24)}`],
    [`stripe sk_test_${'b'.repeat(24)}`, `sk_test_${'b'.repeat(24)}`],
    [`restricted rk_live_${'c'.repeat(24)}`, `rk_live_${'c'.repeat(24)}`],
    ['slack xoxb-1234567890-abcdefghij', 'xoxb-1234567890-abcdefghij'],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0'],
    ['aws AKIAIOSFODNN7EXAMPLE and ASIAIOSFODNN7EXAMPLE', 'IOSFODNN7EXAMPLE'],
    ['connect to postgres://svc:p4ssw0rd@db.internal:5432/x failed', 'p4ssw0rd'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----', 'MIIEow'],
    // JSON written into text, and URL query credentials.
    [`{"password":"${SECRET}"}`, SECRET],
    [`{"api_key": "${SECRET}"}`, SECRET],
    [`https://x/y?access_token=${SECRET}&a=1`, SECRET],
    [`https://x/y?key=${SECRET}`, SECRET],
    [`https://x/y?a=1&api_key=${SECRET}`, SECRET],
    [`refresh_token=${SECRET}`, SECRET],
  ];
  for (const [text, secret] of cases) {
    const out = redactSecretText(text);
    assert.ok(!out.includes(secret), `${text} → ${out}`);
    assert.ok(out.includes(REDACTED), out);
  }
  // The scheme and user of a URL stay — only the password goes; the other query params stay.
  assert.equal(redactSecretText('postgres://svc:p4ss@db/x'), `postgres://svc:${REDACTED}@db/x`);
  assert.equal(redactSecretText(`https://x/y?access_token=${SECRET}&a=1`), `https://x/y?access_token=${REDACTED}&a=1`);
});

test('by value TWIN: prose, cursors, counts, a sha, a UUID and a URL without a password are untouched', () => {
  for (const t of [
    'commit 3f2a9c1b7e4d5a6b8c9d0e1f2a3b4c5d6e7f8a9b', 'id 123e4567-e89b-12d3-a456-426614174000', 'Basic plan costs 10',
    'https://example.com/a@b', 'Token validation failed', 'Basic authentication required', 'next_page_token=abcdef',
    'cursor token=abc123 page', 'input_tokens: 12', 'token: 12', 'key: OPS-1', 'https://x/y?next_page_token=abc&page=2',
  ]) {
    assert.equal(scrubSecrets(t).redactions, 0, `${t} → ${scrubSecrets(t).text}`);
  }
});

test('probe (false negatives): none of the verifier’s cases leaks', () => {
  const cases: Record<string, unknown> = {
    jsonText: `{"password":"${SECRET}"}`,
    jsonApiKeyText: `{"api_key": "${SECRET}"}`,
    xApiKey: { 'x-api-key': SECRET },
    XApiKeyHeader: { headers: { 'X-API-Key': SECRET } },
    apiKeyValue: { apiKeyValue: SECRET },
    sshKey: { ssh_key: SECRET },
    stripe: `sk_live_${'a'.repeat(24)}`,
    deep: JSON.parse('{"a":'.repeat(14) + `{"password":"${SECRET}"}` + '}'.repeat(14)),
    bearerLower: `authorization: bearer ${SECRET}`,
    awsSecretAlone: { aws_secret: SECRET },
    privateToken: { 'PRIVATE-TOKEN': SECRET },
    tokens: { tokens: { access: SECRET } },
    urlQuery: `https://x/y?access_token=${SECRET}&a=1`,
    apikeyQuery: `https://x/y?key=${SECRET}`,
    passwordObj: { password: SECRET },
    clientSecret: { clientSecret: SECRET },
    refreshToken: { refreshToken: SECRET },
    sessionCookie: { session: 'eyJ0eXAiOiJKV1QiLCJhbGciOi0123456789' },
  };
  for (const [k, v] of Object.entries(cases)) assert.equal(leaks(v), false, `${k} leaks: ${JSON.stringify(redactSecrets(v))}`);
});

test('probe (false positives): none of the verifier’s ordinary values is redacted', () => {
  const fp: Record<string, unknown> = {
    max_tokens: { max_tokens: 500 }, page_token: { page_token: 'abc' }, nextPageToken: { nextPageToken: 'abc' }, issueKey: { issueKey: 'OPS-1' },
    credentialMode: { credentialMode: 'owner' }, credentialSubject: { credentialSubject: 'olga' }, secretName: { secretName: 'k8s-ref' },
    session: { session: 'chat-1' }, sessionId: { sessionId: 'abc' }, authType: { authType: 'basic' }, tokenizer: { tokenizer: 'cl100k' },
    textPageToken: 'next_page_token=abcdef', textTokenWord: 'Token validation failed', textBasic: 'Basic authentication required',
    tokenType: { token_type: 'Bearer' }, total_tokens: { total_tokens: 12 }, input_tokens: 'input_tokens: 12', tokenCount: 'token: 12',
    cursorText: 'cursor token=abc123 page', author: { author: 'x' }, keyText: 'key: OPS-1',
    attribution: { actingUser: 'carl', credentialMode: 'owner', credentialSubject: 'olga', connectionId: 'c1', requestedBy: 'carl', approvedBy: 'dana' },
  };
  for (const [k, v] of Object.entries(fp)) assert.deepEqual(redactSecrets(v), v, `${k} was changed: ${JSON.stringify(redactSecrets(v))}`);
});

test('by key name: whole words — secrets are caught, ordinary fields are not over-redacted', () => {
  for (const k of ['password', 'PASSWORD', 'db_password', 'pwd', 'passphrase', 'clientSecret', 'client_secret', 'secret', 'apiKey', 'api_key', 'x-api-key', 'X-API-Key', 'apiKeyValue', 'ssh_key', 'accessKey', 'privateKey', 'secret_access_key', 'aws_secret',
    'accessToken', 'access_token', 'refresh_token', 'token', 'authToken', 'PRIVATE-TOKEN', 'auth', 'Authorization', 'jwt', 'pat', 'github_pat', 'dsn', 'credential', 'credentials', 'cookie', 'set-cookie', 'connection_string']) {
    assert.equal(isSecretKeyName(k, 'v4lue-of-a-secret'), true, k);
  }
  for (const k of ['max_tokens', 'maxTokens', 'tokenizer', 'token_count', 'tokenType', 'page_token', 'pageToken', 'nextPageToken', 'next_token', 'bypass', 'authType', 'author', 'projectKey', 'key', 'issueKey', 'pattern', 'sessions_count', 'dagId', 'description',
    'credentialMode', 'credentialSubject', 'secretName', 'actingUser', 'connectionId']) {
    assert.equal(isSecretKeyName(k, 'x'), false, k);
  }
  // Value-aware: a token COUNT is not a secret; a session ID is not, a session cookie is.
  assert.equal(isSecretKeyName('tokens', 12), false);
  assert.equal(isSecretKeyName('tokens', { access: 'x' }), true);
  assert.equal(isSecretKeyName('session', 'chat-1'), false);
  assert.equal(isSecretKeyName('sessionId', 'abc'), false);
  assert.equal(isSecretKeyName('session', 's3ss10n-c00kie-value-abcdef'), true);
});

test('redactSecrets: deep, never mutates; values of secret keys and secret-shaped strings both go', () => {
  const v = { a: { password: 'x1', nested: [{ note: 'Bearer abcdefgh12345678' }] }, max_tokens: 512, page_token: 'cursor-2', projectKey: 'OPS' };
  const out = redactSecrets(v);
  assert.deepEqual(out, { a: { password: REDACTED, nested: [{ note: `Bearer ${REDACTED}` }] }, max_tokens: 512, page_token: 'cursor-2', projectKey: 'OPS' });
  assert.equal(v.a.password, 'x1');
});

test('fail closed: a subtree deeper than the walk limit is REDACTED whole, never returned raw', () => {
  let deep: Record<string, unknown> = { harmless: 'plain words only' };
  for (let i = 0; i < REDACT_MAX_DEPTH + 3; i++) deep = { a: deep };
  const out = JSON.stringify(redactSecrets(deep));
  assert.ok(!out.includes('plain words only'), 'below the limit nothing is shown raw');
  assert.ok(out.includes(REDACTED));
});

test('one scrubber: git-store re-exports the same function (repository reads redact the same shapes)', () => {
  assert.equal(gitScrub, scrubSecrets);
});

test('S6: the Langfuse export mask redacts secrets too — masking OFF (no policy) and ON', () => {
  const data = JSON.stringify({ input: { args: { password: SECRET, q: `Bearer ${SECRET}` } } });
  for (const policy of [undefined, { enabled: false, level: 'pii' as const }, { enabled: true, level: 'pii' as const }]) {
    const out = maskExportedAttribute(data, policy) as string;
    assert.ok(!out.includes(SECRET), `${JSON.stringify(policy)} → ${out}`);
  }
  assert.ok(!(maskExportedAttribute(`not json: Bearer ${SECRET}`) as string).includes(SECRET), 'non-JSON text too');
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
