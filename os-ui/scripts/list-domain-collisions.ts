/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    List the domains whose ids sanitize to one schema identifier (`a-b` / `a--b` → `a_b`),
 *             and the live domains whose id is reserved (`reservedDomainClashes`).
 * USER STORY: As an operator I want to see, read-only, whether two live domains already share one
 *             schema identifier, before any fix is planned.
 * ARCHITECTURE:
 *   - Pure over an export file: tabs/admin/lib/domains `domainIdsFromJson` + `domainCollisions`.
 *
 *   node --import ./scripts/test-setup.mjs scripts/list-domain-collisions.ts <export.json>…
 *
 * An export is the admin API body (`GET /api/platform-admin/domains`), a plain array of domains, or
 * a search response over the `os-domains` index, exported read-only by an operator. It opens no
 * connection and writes nothing. One JSON line per collision. Exit 0 = none; 1 = listed; 2 = input.
 */
import { readFileSync } from 'node:fs';
import { domainCollisions, domainIdsFromJson, reservedDomainClashes } from '@tabs/admin/lib/domains';

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!files.length) {
  console.error('usage: list-domain-collisions.ts <export.json>…');
  process.exit(2);
}
let domains;
try {
  domains = files.flatMap((f) => domainIdsFromJson(readFileSync(f, 'utf8')));
} catch (e) {
  console.error(`list-domain-collisions: cannot read input: ${(e as Error).message}`);
  process.exit(2);
}
const collisions = domainCollisions(domains);
for (const c of collisions) console.log(JSON.stringify({ kind: 'collision', ...c }));
// Live domains whose id is already reserved (a repository name, a personal lane, a system name).
const reserved = reservedDomainClashes(domains);
for (const r of reserved) console.log(JSON.stringify({ kind: 'reserved', ...r }));
console.error(`list-domain-collisions: ${domains.length} domain(s), ${collisions.length} identifier(s) shared by 2+ domains, ${reserved.length} reserved id(s). Read-only; nothing written or renamed.`);
process.exit(collisions.length || reserved.length ? 1 : 0);
