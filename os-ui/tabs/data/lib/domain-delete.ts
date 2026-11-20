/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Data tab's part of "delete domain": the domain's Iceberg tables (Trino
 *             `DROP TABLE`, Polaris purges the files) and its dataset records (the store's own
 *             `deleteDataset`)
 * USER STORY: As the admin deleting a domain I want every table its datasets wrote gone — legacy
 *             lane names and orphaned layers included — but never a table another domain's
 *             dataset (archived ones too) still maps to.
 * ARCHITECTURE:
 *   - FOOTPRINT, NOT "BUILT" FLAGS. A dataset's candidate tables are every layer of its personal
 *     lane (by its RECORDED lane name: legacy `<layer>_<slug>` or `<layer>_<slug>_<id>`) and, above
 *     the personal tier, its domain-schema copy — whether or not the record says the layer is built
 *     (an archived dataset can say "bronze, silver" while its gold table exists). Only tables Trino
 *     lists in `information_schema` are planned.
 *   - THE KEEP SET is the same footprint of every dataset OUTSIDE the domain, archived included. A
 *     candidate in it is KEPT and named in the plan. Nothing outside the domain's own schema and
 *     the owners' personal schemas is ever a candidate, so another domain's schema
 *     (`agentic_leader_q3_2026.*`) cannot be reached.
 *   - SOLE MEMBERS: a member whose only domain is this one is deactivated by the delete, so every
 *     table left in their personal schema that no other dataset maps to is dropped, then the
 *     schema. Their schema is dropped only when nothing in it is kept.
 *   - Every statement runs AS the schema's owner principal through the injected Trino port (the
 *     governed query-tool in production), the identity the drop route already uses.
 *   - Records go AFTER tables (the component order the doors use): the record is the map from a
 *     dataset to its tables, so a run that stops halfway can still find what is left.
 */
import type { DomainDeleteComponent, KeptItem, PlanItem } from '@core/kernel/domain-delete';
import type { Role } from '@core/kernel/session';
import { listAllDatasets, deleteDataset, ensureHydrated, type Principal } from '@tabs/data/lib/store';
import { domainSchema, personalSchema } from '@tabs/data/lib/store-fqn';
import { footprint, type Candidate } from '@tabs/data/lib/physical-delete';
import { ensureHydrated as ensureDqHydrated, listDqRunsForDomain, purgeDqRunForDomainDelete } from '@tabs/data/lib/dq-results';


export type TrinoIdentity = { principal: string; uid: string; domains: string[]; role: Role };
/** The Trino doors: a governed read returning rows, and a governed statement. */
export type TrinoPort = {
  query(sql: string, identity: TrinoIdentity): Promise<unknown[][]>;
  execute(sql: string, identity: TrinoIdentity): Promise<void>;
};
/** Resolve an artifact owner's LIVE principal; must throw when the owner cannot act. */
export type OwnerPrincipal = (ownerId: string) => Promise<Principal>;

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function icebergComponent(deps: {
  trino: TrinoPort;
  owner: OwnerPrincipal;
  /** Members for whom this is the only domain (they are deactivated by the delete). */
  soleMembers: (domainId: string) => Promise<string[]>;
}): DomainDeleteComponent {
  // The schema owner's principal is the Trino session user (personal schemas are owned by the
  // user alone, a domain schema by the domain principal); the ROLE is the acting admin's, the one
  // the query-tool checks for the governed delete (`purpose: domain-delete`).
  const identityFor = async (uid: string, domainId: string, actorRole: Role): Promise<TrinoIdentity> => {
    const p = await deps.owner(uid);
    return { principal: uid, uid, domains: p.domains.includes(domainId) ? p.domains : [domainId, ...p.domains], role: actorRole };
  };
  const domainIdentity = (domainId: string, actorId: string, actorRole: Role): TrinoIdentity =>
    ({ principal: domainId, uid: actorId, domains: [domainId], role: actorRole });
  const tablesIn = async (schema: string, id: TrinoIdentity): Promise<{ name: string; type: string }[]> => {
    const rows = await deps.trino.query(
      `SELECT table_name, table_type FROM iceberg.information_schema.tables WHERE table_schema = ${q(schema)}`,
      id,
    );
    return rows.map((r) => ({ name: String(r[0]), type: String(r[1]) }));
  };
  const schemaExists = async (schema: string, id: TrinoIdentity): Promise<boolean> =>
    (await deps.trino.query(`SELECT schema_name FROM iceberg.information_schema.schemata WHERE schema_name = ${q(schema)}`, id)).length > 0;

  return {
    component: 'trino',
    async plan({ domainId, actor }) {
      await ensureHydrated();
      const all = listAllDatasets({ includeArchived: true });
      const mine = all.filter((d) => d.domain === domainId);
      const protectedBy = new Map<string, string>();
      for (const o of all) if (o.domain !== domainId) for (const c of footprint(o)) protectedBy.set(c.fqn, `${o.id} (${o.domain}${o.archived ? ', archived' : ''})`);

      // Schemas to inspect, each with the principal that owns it.
      const schemas = new Map<string, { kind: 'personal' | 'domain'; uid: string; sole: boolean }>();
      const sole = new Set(await deps.soleMembers(domainId));
      for (const d of mine) schemas.set(personalSchema(d.owner), { kind: 'personal', uid: d.owner, sole: sole.has(d.owner) });
      for (const u of sole) schemas.set(personalSchema(u), { kind: 'personal', uid: u, sole: true });
      const dom = domainSchema(domainId);
      // Two domain ids can normalise to one schema (`a-b`, `a_b`): then it is not this domain's alone.
      const shared = all.some((o) => o.domain !== domainId && domainSchema(o.domain) === dom);
      schemas.set(dom, { kind: 'domain', uid: actor.id, sole: !shared });

      const candidates = new Map<string, Candidate>();
      for (const d of mine) for (const c of footprint(d)) candidates.set(c.fqn, c);

      const remove: PlanItem[] = [];
      const keep: KeptItem[] = [];
      const schemaDrops: PlanItem[] = [];
      for (const [schema, s] of schemas) {
        const id = s.kind === 'domain' ? domainIdentity(domainId, actor.id, actor.role) : await identityFor(s.uid, domainId, actor.role);
        if (!(await schemaExists(schema, id))) continue;
        const existing = await tablesIn(schema, id);
        let keptHere = 0;
        for (const t of existing) {
          const fqn = `iceberg.${schema}.${t.name}`;
          const cand = candidates.get(fqn);
          // A table in someone's personal schema that is not this domain's, and whose owner stays
          // a member elsewhere, belongs to that owner's other work: not a candidate at all.
          if (!cand && !s.sole) {
            keptHere++;
            keep.push({ component: 'trino', kind: t.type === 'VIEW' ? 'view' : 'table', id: `${schema}|${t.name}`, label: `iceberg.${schema}.${t.name}`, reason: `not a table of ${domainId}: ${s.uid} keeps other domains, so their other work stays` });
            continue;
          }
          const object = t.type === 'VIEW' ? 'view' : 'table';
          const item: PlanItem = { component: 'trino', kind: object, id: `${schema}|${t.name}|${object}|${s.kind === 'domain' ? `domain:${domainId}` : s.uid}`, label: fqn, ...(cand ? { detail: `dataset ${cand.dataset}` } : { detail: 'no dataset maps to it' }) };
          const by = protectedBy.get(fqn);
          if (by) { keep.push({ ...item, reason: `still mapped by dataset ${by}` }); keptHere++; continue; }
          remove.push(item);
        }
        if (s.sole && keptHere === 0) schemaDrops.push({ component: 'trino', kind: 'schema', id: `${schema}||schema|${s.kind === 'domain' ? `domain:${domainId}` : s.uid}`, label: `iceberg.${schema}` });
      }
      return { component: 'trino', remove: [...remove, ...schemaDrops], keep };
    },
    async remove(item, { domainId, actor }) {
      const [schema, table, object, who] = item.id.split('|');
      const id = who.startsWith('domain:') ? domainIdentity(domainId, actor.id, actor.role) : await identityFor(who, domainId, actor.role);
      if (object === 'schema') {
        await deps.trino.execute(`DROP SCHEMA IF EXISTS iceberg.${schema}`, id);
        return `DROP SCHEMA iceberg.${schema}`;
      }
      const stmt = `DROP ${object === 'view' ? 'VIEW' : 'TABLE'} IF EXISTS iceberg.${schema}.${table}`;
      await deps.trino.execute(stmt, id);
      return stmt;
    },
  };
}

/** The domain's dataset RECORDS, through the store's own delete, acting as each owner (a
 *  personal dataset is owner-only; the admin's delete is the owner's act, audited as the admin's). */
export function datasetsComponent(deps: { owner: OwnerPrincipal }): DomainDeleteComponent {
  return {
    component: 'os.datasets',
    async plan({ domainId }) {
      await ensureHydrated();
      const all = listAllDatasets({ includeArchived: true });
      const mine = all.filter((d) => d.domain === domainId);
      const remove: PlanItem[] = [];
      const blocked: KeptItem[] = [];
      for (const d of mine) {
        const item = { component: 'os.datasets', kind: 'dataset', id: d.id, label: `${d.id} ${d.name}`, owner: d.owner, ...(d.archived ? { detail: 'archived' } : {}) };
        const readers = all.filter((o) => o.domain !== domainId && (o.upstreams ?? []).some((u) => u.datasetId === d.id || footprint(d).some((c) => c.fqn === u.fqn)));
        if ((d.imports?.length ?? 0) > 0) blocked.push({ ...item, reason: `imported by ${d.imports!.join(', ')}: remove the subscribers first` });
        else if (readers.length) blocked.push({ ...item, reason: `joined as an upstream by ${readers.map((o) => `${o.id} (${o.domain})`).join(', ')}: their rebuilds would break` });
        else remove.push(item);
      }
      return { component: 'os.datasets', remove, keep: [], blocked };
    },
    async remove(item) {
      const all = listAllDatasets({ includeArchived: true });
      if (!all.some((d) => d.id === item.id)) return 'already absent';
      deleteDataset(item.id, await deps.owner(item.owner!));
      return 'deleteDataset (record, versions, dbt project regenerated)';
    },
  };
}

/** The domain's data-quality run history (`os-dq-results`), through the store's confirmed delete. */
export function dqResultsComponent(): DomainDeleteComponent {
  return {
    component: 'os.dq-results',
    async plan({ domainId }) {
      await ensureDqHydrated();
      const remove = listDqRunsForDomain(domainId).map((r): PlanItem => ({ component: 'os.dq-results', kind: 'dq-run', id: r.id, label: r.id }));
      return { component: 'os.dq-results', remove, keep: [] };
    },
    async remove(item) {
      return `os-dq-results ${await purgeDqRunForDomainDelete(item.id)}`;
    },
  };
}

/** A domain's datasets (archived included) with their measure names — for the Metrics part. */
export async function datasetMeasuresForDomain(domainId: string): Promise<{ id: string; owner: string; measures: string[] }[]> {
  await ensureHydrated();
  return listAllDatasets({ includeArchived: true }).filter((d) => d.domain === domainId).map((d) => ({ id: d.id, owner: d.owner, measures: (d.measures ?? []).map((m) => m.name) }));
}
