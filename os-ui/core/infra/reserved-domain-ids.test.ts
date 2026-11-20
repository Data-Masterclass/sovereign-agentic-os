/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Reserved domain ids — no domain may take an identity the platform already uses
 * USER STORY: As a platform admin I must never create a domain whose id, repository name or Trino
 *             schema is already another thing's: another domain's repository (`domain-sales` IS the
 *             repository of domain `sales`), a person's lane (`personal_*`, `user-*`) or a system
 *             name Trino, the catalog or the OS uses.
 * ARCHITECTURE: `reservedDomainIdReason(id)` checks BOTH forms — the id as a repository name
 *             (repo-layout's own parser) and its Trino schema (the same sanitizer the data tab's
 *             `domainSchema` uses). Every case has a negative twin that must stay creatable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { RESERVED_SCHEMA_NAMES, reservedDomainIdReason } from '@core/infra/reserved-domain-ids';

const refused: [string, RegExp][] = [
  ['domain-sales', /repository/],
  ['domain_sales', /repository|schema/],
  ['user-abc123', /repository/],
  ['user_bob', /repository|schema/],
  ['platform', /reserved/],
  ['personal', /personal lane/],
  ['personal-alice', /personal lane/],
  ['personal_alice', /personal lane/],
  ['information-schema', /system/],
  ['system', /system/],
  ['default', /system/],
  ['global', /system/],
  ['iceberg', /system/],
  ['os', /system|reserved/],
];
for (const [id, why] of refused) {
  test(`refused: ${id}`, () => {
    const r = reservedDomainIdReason(id);
    assert.ok(r, `${id} must be refused`);
    assert.match(r!, why);
  });
}

const allowed = ['sales', 'platform-team', 'personalfinance', 'domainsales', 'users', 'user', 'system-ops', 'osaka', 'icebergs', 'global-markets', 'defaults'];
for (const id of allowed) {
  test(`TWIN allowed: ${id}`, () => {
    assert.equal(reservedDomainIdReason(id), null);
  });
}

test('DRIFT GUARD: the chart’s Trino catalog and resource-group roots are reserved schema names', () => {
  const values = yaml.load(readFileSync(join(import.meta.dirname, '..', '..', '..', 'charts', 'sovereign-agentic-os', 'values.yaml'), 'utf8')) as Record<string, any>;
  const find = (o: any): any[] => (o && typeof o === 'object' ? (Array.isArray(o.rootGroups) ? [o.rootGroups] : Object.values(o).flatMap(find)) : []);
  const roots = find(values).flat().map((g: { name: string }) => g.name);
  assert.ok(roots.length > 0, 'the chart defines resource-group roots');
  for (const r of roots) assert.ok(RESERVED_SCHEMA_NAMES.has(r), `resource-group root '${r}' must be reserved`);
  const trino = readFileSync(join(import.meta.dirname, '..', '..', '..', 'charts', 'sovereign-agentic-os', 'templates', 'extensions', 'lakehouse', 'trino.yaml'), 'utf8');
  for (const m of trino.matchAll(/^\s{2}([a-z_]+)\.properties: \|/gm)) assert.ok(RESERVED_SCHEMA_NAMES.has(m[1]), `catalog '${m[1]}' must be reserved`);
});
