#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * AREA:       repo tooling
 * FEATURE:    one OpenSearch client in os-ui (WP-21, design 02 step 2)
 * USER STORY: As an operator turning on OpenSearch authentication (WP-22) I want every os-ui
 *             caller to go through ONE client, so credentials are added in exactly one place
 *             and no caller is left sending anonymous requests that 401 forever.
 * ARCHITECTURE:
 *   - Scans os-ui source (.ts .tsx .mjs .js; not node_modules / .next) and fails on any file
 *     outside `core/adapters/opensearch/` that names the OpenSearch endpoint itself:
 *     `opensearchUrl` (the old `config.opensearchUrl`), the `OPENSEARCH_URL` env var, the
 *     `OPENSEARCH_USERNAME` / `OPENSEARCH_PASSWORD` credentials, or a literal `:9200` port.
 *   - Such a file is building its own `fetch` to OpenSearch and bypasses the client.
 *   - `*.test.*` files may contain the literal default URL: their fetch mocks match it to
 *     intercept the client's calls. They may not read the env or `opensearchUrl` themselves.
 *   - `--root <dir>` scans another tree (the negative-twin test uses a fixture).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argRoot = process.argv.indexOf('--root');
const ROOT = argRoot > 0 ? resolve(process.argv[argRoot + 1]) : join(repo, 'os-ui');
const ALLOWED = `core${sep}adapters${sep}opensearch${sep}`;
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'vendor']);
const EXT = /\.(ts|tsx|mjs|js)$/;
const PATTERNS = [
  [/\bopensearchUrl\b/, '`opensearchUrl` (use opensearchFetch / opensearchTry / opensearchRequestUrl() from @core/adapters/opensearch/client)'],
  [/\bOPENSEARCH_(URL|USERNAME|PASSWORD)\b/, 'reads the OpenSearch endpoint/credential env itself'],
  [/:9200\b/, 'a literal OpenSearch port', 'not-in-tests'],
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (EXT.test(name)) yield p;
  }
}

const problems = [];
for (const f of walk(ROOT)) {
  const rel = relative(ROOT, f);
  if (rel.startsWith(ALLOWED)) continue;
  const lines = readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const [re, why, scope] of PATTERNS) {
      // Test fetch mocks match the default URL to INTERCEPT calls; they are not callers.
      if (scope === 'not-in-tests' && /\.test\.(ts|tsx|mjs)$/.test(rel)) continue;
      if (re.test(line)) problems.push(`${rel}:${i + 1}: ${why}`);
    }
  });
}

if (problems.length) {
  console.error('check-opensearch-client FAILED — these files bypass core/adapters/opensearch/client.ts:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('check-opensearch-client: ok — every OpenSearch call in os-ui goes through core/adapters/opensearch/client.ts');
