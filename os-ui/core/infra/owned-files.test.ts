/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    A visible list of domains whose receive gate is failing closed
 * USER STORY: As an admin I want to SEE which domains are missing the OS's list of generated files
 *             (so builders cannot push models/tests there) and to reconcile them, not find out from a
 *             refused push.
 * ARCHITECTURE: Real git store. A domain is "missing" when its head has no readable
 *             `os/owned-files.yml` with a `files` map; a domain with no commit yet is not listed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commitTree } from '@core/infra/git-store';
import { domainsMissingOwnedFiles } from '@core/infra/owned-files';

const author = { name: 'Writer', email: 'writer@os.invalid' };

test('domains whose head has no usable os/owned-files.yml are listed; the rest are not', async () => {
  const reposDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-'));
  const tree = (extra: [string, string][]) => new Map<string, string>([['dbt_project.yml', 'name: s\n'], ...extra]);
  await commitTree('has', tree([['os/owned-files.yml', 'version: 1\nfiles: {}\n']]), { author, message: 'a', reposDir });
  await commitTree('lacks', tree([]), { author, message: 'b', reposDir });
  await commitTree('broken', tree([['os/owned-files.yml', 'version: 1\nnotfiles: 1\n']]), { author, message: 'c', reposDir });
  assert.deepEqual(await domainsMissingOwnedFiles({ reposDir }), ['broken', 'lacks']);
});

test('NEGATIVE TWIN: no repositories at all means nothing is missing', async () => {
  const reposDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-empty-'));
  assert.deepEqual(await domainsMissingOwnedFiles({ reposDir }), []);
});
