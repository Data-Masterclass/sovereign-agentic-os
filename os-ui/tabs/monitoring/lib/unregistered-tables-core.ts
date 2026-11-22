/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Tables created directly in Trino and unknown to the OS raise an alert
 * USER STORY: As a domain admin I am told about a table in my domain's schema that no dataset
 *             registers, instead of a shadow table nobody governs.
 * ARCHITECTURE: pure over the physical tables Trino lists and the registered footprint (every table a
 *   dataset can occupy). Judged: the domains' schemas and personal lanes. Not judged: dlt landing
 *   schemas, Iceberg metadata tables (`name$snapshots`) and every other schema. One warning per
 *   schema, naming up to ten tables. Trino owns such a table; the OS only reports it.
 */
import type { Alert } from '@tabs/monitoring/lib/types';
import type { PhysicalTable } from '@core/adapters/trino/tables';

export type Judged = { domainSchemas: string[]; personalSchemaPrefix: string };

export function unregisteredTableAlerts(physical: readonly PhysicalTable[], registered: ReadonlySet<string>, judged: Judged): Alert[] {
  const domainOf = new Set(judged.domainSchemas);
  const bySchema = new Map<string, string[]>();
  for (const p of physical) {
    if (p.table.includes('$')) continue;
    const judgedSchema = domainOf.has(p.schema) || p.schema.startsWith(judged.personalSchemaPrefix);
    if (!judgedSchema || registered.has(`${p.schema}.${p.table}`)) continue;
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
