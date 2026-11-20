/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Reserved domain ids — a domain may never take an identity the platform already uses
 * USER STORY: As a platform admin I must not be able to create a domain whose id, repository name
 *             or Trino schema is already something else's: another domain's repository, a person's
 *             repository or lane, or a name Trino, the catalog or the OS uses.
 * ARCHITECTURE:
 *   - TWO FORMS, both checked: the id read as a REPOSITORY NAME (repo-layout's own
 *     `isReservedRepoName`: `platform`, `user-*`, `domain-*` — `domain-sales` IS the repository of
 *     domain `sales`), and the id's Trino SCHEMA (`domainIdent`, the sanitizer the data tab's
 *     `domainSchema` uses), so `domain_sales`/`user_bob`, the personal lanes (`personal`,
 *     `personal_*`, built from `PERSONAL_SCHEMA_PREFIX`, which `store-fqn.personalSchema` uses
 *     too) and the system names are refused however they are spelled.
 *   - Names derived from OS code come from their constants (repo prefixes, `PLATFORM_REPO`,
 *     `OS_DIR`, `LEGACY_PERSONAL_DIR`). Names that belong to Trino are listed with their source;
 *     the chart's catalog and resource-group roots are pinned to `values.yaml`/`trino.yaml` by a
 *     drift test (`reserved-domain-ids.test.ts`).
 *   - PURE. Used at domain create (refuse) and by the read-only live listing (report, never fix).
 */
import { domainIdent, PERSONAL_SCHEMA_PREFIX } from '@core/kernel/domain-ident';
import { DOMAIN_REPO_PREFIX, LEGACY_PERSONAL_DIR, OS_DIR, PLATFORM_REPO, USER_REPO_PREFIX, isReservedRepoName } from '@core/infra/repo-layout';

/**
 * Schema names a domain may never take.
 * - Trino: `information_schema` (in every catalog) and `system` (the system catalog and the
 *   resource-group `global.system` sub-group): https://trino.io/docs/current/connector/system.html ·
 *   https://trino.io/docs/current/language/reserved.html. `default` is the default namespace Trino and
 *   Iceberg catalogs fall back to.
 * - The chart: the Iceberg catalog `iceberg` (`iceberg.properties`) and the resource-group root
 *   `global` — drift-tested against the chart.
 * - The OS: its own layer folder and the platform repository.
 */
export const RESERVED_SCHEMA_NAMES: ReadonlySet<string> = new Set([
  'information_schema',
  'system',
  'default',
  'iceberg',
  'global',
  domainIdent(OS_DIR),
  domainIdent(PLATFORM_REPO),
]);

/** Schema prefixes that are someone else's namespace: user and domain repository names, as schemas. */
const REPO_SCHEMA_PREFIXES = [USER_REPO_PREFIX, DOMAIN_REPO_PREFIX].map((p) => `${domainIdent(p)}_`);
const PERSONAL_LANE = PERSONAL_SCHEMA_PREFIX.replace(/_+$/, '');

/** Why `id` may not be a domain id, or null when it may. */
export function reservedDomainIdReason(id: string): string | null {
  if (id === PLATFORM_REPO) return `"${id}" is reserved: the platform repository and Trino's access rules use it`;
  if (isReservedRepoName(id)) return `"${id}" reads as another repository's name (${USER_REPO_PREFIX}* is a person's repository, ${DOMAIN_REPO_PREFIX}* another domain's)`;
  const schema = domainIdent(id);
  if (REPO_SCHEMA_PREFIXES.some((p) => schema.startsWith(p))) return `"${id}" has the schema ${schema}, which reads as another repository's name`;
  if (schema === PERSONAL_LANE || schema === domainIdent(LEGACY_PERSONAL_DIR) || schema.startsWith(PERSONAL_SCHEMA_PREFIX)) {
    return `"${id}" has the schema ${schema}, which is a personal lane (${PERSONAL_SCHEMA_PREFIX}<person>)`;
  }
  if (RESERVED_SCHEMA_NAMES.has(schema)) return `"${id}" has the schema ${schema}, a system name used by Trino, the catalog or the OS`;
  return null;
}
