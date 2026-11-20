/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Admin tab's part of "delete domain": OPA governance data, the LiteLLM team and
 *             keys, the members, the domain record, and the 2 h backup gate (Velero)
 * USER STORY: As the admin deleting a domain I want its policy entries, gateway team and keys,
 *             memberships and registry entry gone, each through that component's own API, and
 *             the delete refused unless a fresh backup exists.
 * ARCHITECTURE:
 *   - OPA: the Data API (`GET`/`DELETE`/`PUT /v1/data/governance/...`) through `core/policy/opa-publish`.
 *     Only keys of THIS domain go: tables in the domain's schema, the domain's principal and its
 *     sole members' principals; a member of other domains keeps their principal with this domain
 *     removed from its list. Another domain's keys are never written.
 *   - LiteLLM: `/team/list`, `/key/list`, then `/team/delete` and `/key/delete` (the admin API, the
 *     master key stays in core/infra/litellm-*). The team alias is the domain id; agent keys are
 *     `os-<systemId>` (minted by Build) and `agent-<systemId>` (reconcile's alias).
 *   - Members: a member whose only domain this is is ARCHIVED (cannot sign in) and deactivated,
 *     then loses the membership; every other member only loses this domain. The admin acting is
 *     never deactivated by this.
 *   - The record goes LAST, through the registry's confirmed mirror delete, then the policy
 *     compiler republishes the grants document without the domain (injected `recompile`).
 *   - Backups: the newest COMPLETED Velero Backup (`velero.io/v1`) that includes the platform
 *     namespace, read through the Kubernetes API. Nothing else counts as a backup here.
 */
import 'server-only';
import type { DomainDeleteComponent, KeptItem, PlanItem, BackupCheck } from '@core/kernel/domain-delete';
import { publishOpa, readOpaData } from '@core/policy/opa-publish';
import { readKeys, readTeams } from '@core/infra/litellm-admin';
import { adminPost } from '@core/infra/litellm-write';
import { k8s } from '@core/infra/k8s';
import { config } from '@core/kernel/config';
import { listUsers, removeDomainFromUser } from '@tabs/admin/lib/users';
import { deactivateUser, ensureHydrated as ensureTenantUsersHydrated } from '@tabs/admin/lib/tenant-users';
import { listDomains, removeDomain } from '@tabs/admin/lib/domains';

const sanitize = (v: string) => (v || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'user';

/** Members for whom `domainId` is the only domain. */
export async function soleMembers(domainId: string): Promise<string[]> {
  return (await listUsers()).filter((u) => u.domains.length === 1 && u.domains[0] === domainId).map((u) => u.id);
}

// ------------------------------------------------------------------------------------- OPA --

type Principals = Record<string, { domains?: string[]; clearances?: string[] }>;

export function opaComponent(): DomainDeleteComponent {
  const read = async (path: string): Promise<Record<string, unknown>> => {
    const r = await readOpaData(path);
    if (!r.reachable) throw new Error(`OPA unreachable reading ${path}: ${r.detail ?? ''}`);
    return r.defined && r.value && typeof r.value === 'object' ? (r.value as Record<string, unknown>) : {};
  };
  return {
    component: 'opa',
    async plan({ domainId }) {
      const schema = sanitize(domainId);
      const tables = await read('governance/tables');
      const principals = (await read('governance/principals')) as Principals;
      const sole = new Set(await soleMembers(domainId));
      const remove: PlanItem[] = [];
      for (const fqn of Object.keys(tables)) {
        if (fqn.split('.')[1] === schema) remove.push({ component: 'opa', kind: 'governance-table', id: fqn, label: `governance/tables/${fqn}` });
      }
      for (const [id, p] of Object.entries(principals)) {
        const doms = p?.domains ?? [];
        if (id === domainId || (sole.has(id) && doms.every((d) => d === domainId))) {
          remove.push({ component: 'opa', kind: 'governance-principal', id, label: `governance/principals/${id}` });
        } else if (doms.includes(domainId)) {
          remove.push({ component: 'opa', kind: 'governance-principal-domain', id, label: `governance/principals/${id}`, detail: `drop "${domainId}" from its domains` });
        }
      }
      return { component: 'opa', remove, keep: [] };
    },
    async remove(item, { domainId }) {
      const base = item.kind === 'governance-table' ? 'governance/tables' : 'governance/principals';
      const path = `${base}/${encodeURIComponent(item.id)}`;
      if (item.kind === 'governance-principal-domain') {
        const cur = await readOpaData(path);
        if (!cur.reachable) throw new Error(`OPA unreachable: ${cur.detail ?? ''}`);
        if (!cur.defined) return 'already absent';
        const p = cur.value as { domains?: string[]; clearances?: string[] };
        const r = await publishOpa({ kind: 'data', path, value: { ...p, domains: (p.domains ?? []).filter((d) => d !== domainId) } });
        if (!r.ok) throw new Error(r.detail);
        return `PUT data/${path} without ${domainId}`;
      }
      const r = await publishOpa({ kind: 'delete', path });
      if (!r.ok) throw new Error(r.detail);
      return `DELETE data/${path}`;
    },
  };
}

// --------------------------------------------------------------------------------- LiteLLM --

export function litellmComponent(deps: { agentSystemIds: (domainId: string) => Promise<string[]> }): DomainDeleteComponent {
  return {
    component: 'litellm',
    async plan({ domainId }) {
      const teams = await readTeams();
      if (!teams.ok) throw new Error(`LiteLLM /team/list: ${teams.error}`);
      const keys = await readKeys();
      if (!keys.ok) throw new Error(`LiteLLM /key/list: ${keys.error}`);
      const team = teams.data.filter((t) => t.team_alias === domainId && t.team_id);
      const teamIds = new Set(team.map((t) => t.team_id!));
      const aliases = new Set((await deps.agentSystemIds(domainId)).flatMap((id) => [`os-${id}`, `agent-${id}`]));
      const remove: PlanItem[] = [];
      for (const k of keys.data) {
        if (!k.token) continue;
        if ((k.key_alias && aliases.has(k.key_alias)) || (k.team_id && teamIds.has(k.team_id))) {
          remove.push({ component: 'litellm', kind: 'key', id: k.token, label: `key ${k.key_alias ?? '(no alias)'}` });
        }
      }
      for (const t of team) remove.push({ component: 'litellm', kind: 'team', id: t.team_id!, label: `team ${t.team_alias}` });
      return { component: 'litellm', remove, keep: [] };
    },
    async remove(item) {
      const r = item.kind === 'team'
        ? await adminPost('/team/delete', { team_ids: [item.id] })
        : await adminPost('/key/delete', { keys: [item.id] });
      if (!r.ok) {
        // An already-deleted object is done (LiteLLM answers 404/400 naming it as not found).
        if (/not.?found|does not exist/i.test(r.error)) return 'already absent';
        throw new Error(`LiteLLM /${item.kind}/delete: ${r.error}`);
      }
      return `POST /${item.kind}/delete`;
    },
  };
}

// --------------------------------------------------------------------------------- members --

export function membersComponent(): DomainDeleteComponent {
  return {
    component: 'users',
    async plan({ domainId, actor }) {
      const users = await listUsers();
      const remove: PlanItem[] = [];
      const keep: KeptItem[] = [];
      for (const u of users.filter((x) => x.domains.includes(domainId))) {
        const only = u.domains.length === 1;
        const item: PlanItem = { component: 'users', kind: only ? 'deactivate' : 'membership', id: u.id, label: u.id, detail: only ? 'only domain: deactivate, then remove the membership' : `remove "${domainId}", keep ${u.domains.filter((d) => d !== domainId).join(', ')}` };
        if (only && u.id === actor.id) keep.push({ ...item, reason: 'the acting admin is never deactivated' });
        else remove.push(item);
      }
      return { component: 'users', remove, keep };
    },
    async remove(item, { domainId }) {
      await ensureTenantUsersHydrated();
      if (!(await listUsers()).some((x) => x.id === item.id)) return 'already absent';
      // Archive (cannot sign in) and drop the membership in ONE confirmed user write.
      await removeDomainFromUser(item.id, domainId, { disable: item.kind === 'deactivate' });
      if (item.kind === 'deactivate') await deactivateUser(item.id);
      return item.kind === 'deactivate' ? 'archived + deactivated, membership removed' : 'membership removed';
    },
  };
}

// ---------------------------------------------------------------------------- the record --

export function domainRecordComponent(deps: { recompile: () => Promise<void> }): DomainDeleteComponent {
  return {
    component: 'domain',
    async plan({ domainId }) {
      const d = listDomains().find((x) => x.id === domainId);
      return { component: 'domain', remove: d ? [{ component: 'domain', kind: 'domain', id: d.id, label: `domain ${d.id} (${d.name})` }] : [], keep: [] };
    },
    async remove(item) {
      const r = await removeDomain(item.id);
      await deps.recompile();
      return `registry ${r}; grants recompiled`;
    },
  };
}

// --------------------------------------------------------------------------- backup gate --

type VeleroBackup = { metadata?: { name?: string }; spec?: { includedNamespaces?: string[] }; status?: { phase?: string; completionTimestamp?: string } };

/** The newest completed Velero Backup covering the platform namespace (`velero.io/v1`). */
export function veleroBackupCheck(veleroNamespace = 'velero'): BackupCheck {
  return async () => {
    const r = await k8s('GET', `/apis/velero.io/v1/namespaces/${veleroNamespace}/backups`);
    if (r.status !== 200) return { ok: false, reason: `Velero backups unreadable (Kubernetes API ${r.status || 'unreachable'})` };
    const ns = config.platformNamespace;
    const items = ((r.body.items as VeleroBackup[]) ?? [])
      .filter((b) => b.status?.phase === 'Completed' && b.status.completionTimestamp)
      .filter((b) => { const inc = b.spec?.includedNamespaces ?? []; return inc.length === 0 || inc.includes('*') || inc.includes(ns); })
      .sort((a, b) => b.status!.completionTimestamp!.localeCompare(a.status!.completionTimestamp!));
    if (!items.length) return { ok: false, reason: `no completed Velero backup includes ${ns}` };
    return { ok: true, name: items[0].metadata?.name ?? '(unnamed)', at: items[0].status!.completionTimestamp! };
  };
}
