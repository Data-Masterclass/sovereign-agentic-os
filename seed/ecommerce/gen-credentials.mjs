#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Data Masterclass
 *
 * Generate demo credentials for the Northpeak cast. NO password is ever committed:
 * this writes two GITIGNORED files next to it and prints nothing secret to logs by
 * default. The cast are GOVERNED demo identities (operator pre-seed via OS_USERS) —
 * they are NOT the human operator's admin account.
 *
 *   node seed/ecommerce/gen-credentials.mjs
 *     → users.secret.json   { "nova-admin": "<pw>", ... }     (SEED_CREDENTIALS input)
 *     → os-users.seed.json  [ { id, name, password, domains, role }, ... ]  (OS_USERS value)
 *
 * Wire-up (live run, never on a tracked file):
 *   - Put the os-users.seed.json array into values as osUI.usersSeed (or the
 *     OS_USERS env / a Secret). Passwords are hashed on ingest by lib/users.ts.
 *   - Pass users.secret.json to the seed Job as SEED_CREDENTIALS (a Secret).
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CAST } from './lib/narrative.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** A readable but high-entropy demo password (~20 url-safe chars). */
function strongPassword() {
  return randomBytes(15).toString('base64url') + 'A9!';
}

const creds = {};
const seed = [];
for (const c of CAST) {
  const password = strongPassword();
  creds[c.id] = password;
  seed.push({ id: c.id, name: c.name, password, domains: c.domains, role: c.role });
}

writeFileSync(join(here, 'users.secret.json'), JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
writeFileSync(join(here, 'os-users.seed.json'), JSON.stringify(seed, null, 2) + '\n', { mode: 0o600 });

console.log(`Wrote ${CAST.length} demo credentials (gitignored):`);
console.log(`  - ${join('seed/ecommerce', 'users.secret.json')}   → SEED_CREDENTIALS for the seed Job`);
console.log(`  - ${join('seed/ecommerce', 'os-users.seed.json')}  → OS_USERS / osUI.usersSeed value`);
console.log('Neither file is tracked by git. Do not paste their contents into logs or chat.');
