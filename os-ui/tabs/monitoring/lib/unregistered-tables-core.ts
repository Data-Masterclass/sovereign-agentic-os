/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Tables created directly in Trino and unknown to the OS raise an alert
 * USER STORY: As a domain admin I am told about a table in my domain's schema that no dataset
 *             registers, instead of a shadow table nobody governs.
 * ARCHITECTURE: pure over the physical tables Trino lists and the registered footprint (every table a
 *   dataset can occupy). Judged: the domains' schemas and personal lanes. Not judged: dlt landing
 *   schemas, OS-internal tables (see `isOsInternal`), Iceberg metadata tables (`name$snapshots`) and every other schema. One warning per
 *   schema, naming up to ten tables. Trino owns such a table; the OS only reports it.
 */
import type { Alert } from '@tabs/monitoring/lib/types';
import type { PhysicalTable } from '@core/adapters/trino/tables';

export type Judged = {
  domainSchemas: string[];
  personalSchemaPrefix: string;
  /** `schema.table` of the dbt models Dagster manages (from its asset keys, `managedTablesOf`): their tables are the repository's. */
  managedTables: ReadonlySet<string>;
};

/**
 * Tables the OS itself writes, so a warning means "made outside the OS":
 *   - every table a dataset can occupy (`registered`, from `footprint()`);
 *   - the merge staging table of such a table, `<table>_stg` (sync-sql.ts), which a failed merge leaves behind;
 *   - the table of a dbt model Dagster manages (git owns the model; Dagster materialises it), matched on
 *     schema AND table.
 */
export function isOsInternal(schema: string, table: string, registered: ReadonlySet<string>, managedTables: ReadonlySet<string>): boolean {
  if (registered.has(`${schema}.${table}`) || managedTables.has(`${schema}.${table}`)) return true;
  return table.endsWith('_stg') && registered.has(`${schema}.${table.slice(0, -4)}`);
}

export function unregisteredTableAlerts(physical: readonly PhysicalTable[], registered: ReadonlySet<string>, judged: Judged): Alert[] {
  const domainOf = new Set(judged.domainSchemas);
  const bySchema = new Map<string, string[]>();
  for (const p of physical) {
    if (p.table.includes('$')) continue;
    const judgedSchema = domainOf.has(p.schema) || p.schema.startsWith(judged.personalSchemaPrefix);
    if (!judgedSchema || isOsInternal(p.schema, p.table, registered, judged.managedTables)) continue;
    bySchema.set(p.schema, [...(bySchema.get(p.schema) ?? []), p.table]);
  }
  return [...bySchema.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([schema, tables]): Alert => {
    const personal = schema.startsWith(judged.personalSchemaPrefix);
    const owner = personal ? schema.slice(judged.personalSchemaPrefix.length) : schema;
    const shown = tables.slice(0, 10).join(', ') + (tables.length > 10 ? `, and ${tables.length - 10} more` : '');
    return {
      id: `al-unregistered-tables-${schema}`, severity: 'warning', domain: personal ? 'platform' : schema, owner, cluster: personal, disposition: 'notified', source: 'live',
      title: `${tables.length} table(s) in ${schema} are not registered in the OS`,
      detail: `Tables created directly in Trino that no dataset registers: ${shown}. Trino owns them and the OS does not govern them as datasets. Register one by adding a dataset for it (a dbt model with a schema.yml pushed to the domain repository becomes a dataset), or drop it if it is scratch.`,
    };
  });
}

/**
 * Dagster asset keys of dbt models -> `schema.table`. dagster-dbt keys are `[domain, schema, model]`;
 * a two-part key `[domain, model]` lives in the domain's schema (`domainSchemaOf`).
 */
export function managedTablesOf(keys: readonly (readonly string[])[], domainSchemaOf: (domain: string) => string): Set<string> {
  const out = new Set<string>();
  for (const k of keys) {
    if (k.length >= 3) out.add(`${k[k.length - 2]}.${k[k.length - 1]}`);
    else if (k.length === 2) out.add(`${domainSchemaOf(k[0])}.${k[1]}`);
  }
  return out;
}
