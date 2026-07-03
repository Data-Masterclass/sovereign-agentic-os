#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Data Masterclass
 *
 * Generate credentials for the Agentic-Leader Q3-2026 cohort from the REAL
 * roster. NO PII and NO password is ever committed: the roster is read from the
 * gitignored `roster.private.csv` (columns: name,email) and this writes two
 * GITIGNORED files next to it.
 *
 *   node seed/campaign/gen-credentials.mjs
 *     → os-users.seed.json  [ { id:email, name, email, password, domains, role }, ... ]
 *         · one row per roster participant: id = email (lowercased), role
 *           'agentic-leader', shared password 'Agentic!Leader2026', domain DOMAIN
 *         · plus ONE instructor row: id 'alp-instructor', role 'builder',
 *           a freshly GENERATED strong password
 *     → users.secret.json   { 'alp-instructor': '<gen>', '<first participant email>': 'Agentic!Leader2026' }
 *         · the live seed only logs in as the instructor + ONE participant to
 *           prove run-scope, so we deliberately do NOT emit 36 identical passwords.
 *
 * Wire-up (live run, never on a tracked file):
 *   - Merge os-users.seed.json into values `osUI.usersSeed` (or OS_USERS). Passwords
 *     are hashed on ingest by lib/users.ts. Every row carries a valid `email` — the
 *     sign-in label (login-by-email); a row with no usable email is skipped.
 *   - Pass users.secret.json to the seed Job as SEED_CREDENTIALS (a Secret).
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DOMAIN, INSTRUCTOR } from './narrative.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** The shared participant password (locked decision — same for the whole cohort). */
const PARTICIPANT_PASSWORD = 'Agentic!Leader2026';

/** A readable but high-entropy password (~20 url-safe chars) for the instructor. */
function strongPassword() {
  return randomBytes(15).toString('base64url') + 'A9!';
}

/** Parse roster.private.csv → [{ name, email }] (header `name,email`, comma-split). */
function readRoster() {
  const raw = readFileSync(join(here, 'roster.private.csv'), 'utf8');
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rows = [];
  for (const line of lines) {
    const [name, email] = line.split(',').map((s) => (s ?? '').trim());
    if (!name || !email || email.toLowerCase() === 'email') continue; // skip header/blank
    rows.push({ name, email: email.toLowerCase() });
  }
  if (rows.length === 0) throw new Error('roster.private.csv has no data rows (expected `name,email`)');
  return rows;
}

const roster = readRoster();

// The instructor row carries a freshly generated strong password.
const instructorPw = strongPassword();
const instructor = {
  id: INSTRUCTOR.id,
  name: INSTRUCTOR.name,
  email: INSTRUCTOR.email,
  password: instructorPw,
  domains: INSTRUCTOR.domains,
  role: INSTRUCTOR.role,
};

// One participant row per roster line: id = email (the user wants email = username).
const participants = roster.map((r) => ({
  id: r.email,
  name: r.name,
  email: r.email,
  password: PARTICIPANT_PASSWORD,
  domains: [DOMAIN],
  role: 'agentic-leader',
}));

const seed = [instructor, ...participants];

// The seed only needs the instructor + ONE participant (first roster email) to
// prove run-scope — NOT 36 identical passwords.
const firstParticipantEmail = participants[0].email;
const creds = {
  [instructor.id]: instructorPw,
  [firstParticipantEmail]: PARTICIPANT_PASSWORD,
};

writeFileSync(join(here, 'users.secret.json'), JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
writeFileSync(join(here, 'os-users.seed.json'), JSON.stringify(seed, null, 2) + '\n', { mode: 0o600 });

console.log(`Wrote ${seed.length} identities (1 instructor + ${participants.length} participants) — gitignored:`);
console.log(`  - ${join('seed/campaign', 'os-users.seed.json')}  → merge into osUI.usersSeed / OS_USERS`);
console.log(`  - ${join('seed/campaign', 'users.secret.json')}   → SEED_CREDENTIALS for the seed Job (instructor + 1 participant)`);
console.log('Neither file is tracked by git. Do not paste their contents into logs or chat.');
