/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    A file uploaded into a folder makes that folder visible in My files
 * USER STORY: As a user (or an agent run saving its declared Files output) I upload into a new
 *             folder and find the folder in the Files rail.
 * ARCHITECTURE:
 *   - `createFile` now ensures the folder row (`ensureFolderRow`) like `moveFile` always did.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __resetStore, createFile } from '@tabs/files/lib/store';
import { __resetStore as resetFolders, listFolders } from '@core/folders/index';

const amir = { id: 'amir', domains: ['sales'], role: 'creator' as const };

beforeEach(() => { __resetStore(); resetFolders(); });

test('createFile into a new folder creates the personal folder row, in the file\'s domain', () => {
  createFile(amir, { name: 'invoice-run.md', text: 'x', folder: '/reports/2026' });
  const rows = listFolders(amir, 'files', 'personal');
  assert.deepEqual(rows.map((n) => n.path), ['/reports/2026']);
  assert.equal(rows[0].domain, 'sales');
});

test('createFile at the root creates no folder row', () => {
  createFile(amir, { name: 'root.md', text: 'x' });
  assert.deepEqual(listFolders(amir, 'files', 'personal'), []);
});
