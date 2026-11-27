/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       os-ui entrypoint
 * FEATURE:    The worker's module hook loads the i18n JSON catalogs
 * USER STORY: As the worker process I can import core/i18n/catalog.ts, whose catalog JSON imports
 *             carry no import attribute, exactly as the Next build compiles them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('the worker hook imports core/i18n/catalog.ts and its JSON catalogs', () => {
  const script = [
    "import { register } from 'node:module';",
    "import { pathToFileURL } from 'node:url';",
    "register('./worker/resolve-hook.mjs', pathToFileURL(process.cwd() + '/'));",
    "const m = await import('./core/i18n/catalog.ts');",
    "if (!m || Object.keys(m).length === 0) throw new Error('catalog module is empty');",
    "console.log('CATALOG_OK');",
  ].join('\n');
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
    cwd: root, encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(r.status, 0, `worker-style import failed:\n${r.stderr}`);
  assert.match(r.stdout, /CATALOG_OK/);
});
