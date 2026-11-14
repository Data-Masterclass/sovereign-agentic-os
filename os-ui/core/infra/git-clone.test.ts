/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The `git clone` command and the repo file link shown on every detail page
 * USER STORY: As the owner I want proof that the command an engineer is told to run is the real
 *             one for however the OS is exposed, and that a link the OS cannot build is ABSENT
 *             rather than half-written (checklist E10).
 * ARCHITECTURE: pure string tests; the component is a shell over exactly these functions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLONE_TOKEN_HINT, cloneCommand, cloneUrl, GIT_HTTP_PATH, repoFileHref } from '@core/infra/git-clone';

test('the clone URL is always <base>/git/<domain>.git', () => {
  assert.equal(GIT_HTTP_PATH, 'git');
  assert.equal(cloneUrl('sales', 'https://os.example.com'), 'https://os.example.com/git/sales.git');
  assert.equal(cloneUrl('sales', 'https://os.example.com/'), 'https://os.example.com/git/sales.git');
  assert.equal(cloneCommand('sales', 'https://os.example.com'), 'git clone https://os.example.com/git/sales.git');
});

test('HTTPS ONLY — a plain-http remote would publish the token on the wire (review M-6)', () => {
  assert.equal(cloneUrl('sales', 'http://os.example.com'), null);
  assert.equal(cloneUrl('sales', 'http://10.0.0.5:3000'), null);
  // Loopback is the one exception: there is no wire, and that is `npm run dev`.
  assert.equal(cloneUrl('sales', 'http://localhost:3000'), 'http://localhost:3000/git/sales.git');
  assert.equal(cloneUrl('sales', 'http://127.0.0.1:3000'), 'http://127.0.0.1:3000/git/sales.git');
  assert.equal(cloneUrl('sales', 'http://localhost.evil.com'), null);
});

test('no base, no scheme or an unsafe domain yields NOTHING — never half a command', () => {
  assert.equal(cloneUrl('sales', ''), null);
  assert.equal(cloneUrl('sales', null), null);
  assert.equal(cloneUrl('sales', 'os.example.com'), null); // a scheme-less host is not a remote
  assert.equal(cloneUrl('../etc', 'https://os.example.com'), null);
  assert.equal(cloneUrl('a..b', 'https://os.example.com'), null);
  assert.equal(cloneCommand('', 'https://os.example.com'), null);
});

test('the file link points at the domain-gated read API, with the path and ref encoded', () => {
  assert.equal(
    repoFileHref('sales', 'models/gold/schema.yml', 'abc123'),
    '/api/data/projects/sales/blob?path=models%2Fgold%2Fschema.yml&ref=abc123',
  );
  assert.equal(repoFileHref('sales', 'models/gold/schema.yml'), '/api/data/projects/sales/blob?path=models%2Fgold%2Fschema.yml');
  assert.equal(repoFileHref('sales', '../../etc/passwd'), null);
  assert.equal(repoFileHref('sales', ''), null);
});

test('the token hint names the token, says reading is unconditional, and carries no token', () => {
  assert.match(CLONE_TOKEN_HINT, /personal access token/);
  assert.match(CLONE_TOKEN_HINT, /os\/\*\.yml/);
  assert.equal(/sos_[0-9a-f]{12}_/.test(CLONE_TOKEN_HINT), false);
});
