/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import { roleAtLeast } from '@/lib/core/session';
import { osMirror } from '@/lib/infra/os-mirror';
import { trace } from '@/lib/infra/agent-governed';
import { getConnectionById } from '@/lib/connections/store';
import { entityActionKey } from '@/lib/connections/exposures';

/**
 * DOMAIN ACTION ADOPTION (operational-system-connections.md, Phase 3) — the consent
 * step that keeps an exposure from silently arming ANOTHER domain's agents. A platform
 * admin's exposure grants entity actions; before those action tools become callable
 * for a domain's principals, a `domain_admin` of that domain must ADOPT the actions
 * for the specific entities. This is the third layer of the four-layer fail-closed
 * intersection: capability profile ∩ exposure actions ∩ DOMAIN ADOPTION ∩ agent grant.
 *
 * Mirrors the `os-exposures` store pattern (in-process authoritative Map + best-effort
 * OpenSearch write-through, durable across a pod roll). Every mutation is audit-traced.
 * Revocation is soft (freeze-not-delete) so the record survives for audit; a revoked
 * adoption kills the actions immediately (the intersection recomputes per call — no
 * cache outlives the revoke).
 */

export type ActionAdoption = {
  id: string;
  exposureId: string;
  domain: string;
  /** The entity keys (lowercased SObject names) this domain adopted actions for. */
  entities: string[];
  adoptedBy: string;
  at: string;
  revoked?: boolean;
};

function now(): string {
  return new Date().toISOString();
}
function id(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
}
function withStatus(err: Error, status: number): Error {
  (err as Error & { status?: number }).status = status;
  return err;
}

const mirror = osMirror({ index: 'os-action-adoptions' });

type AdCacheState = { cache: Map<string, ActionAdoption> | null };
const AD_STATE_KEY = Symbol.for('soa.actionAdoptions.cache');
function adState(): AdCacheState {
  const g = globalThis as unknown as Record<symbol, AdCacheState | undefined>;
  if (!g[AD_STATE_KEY]) g[AD_STATE_KEY] = { cache: null };
  return g[AD_STATE_KEY]!;
}

async function getCache(): Promise<Map<string, ActionAdoption>> {
  const s = adState();
  if (s.cache) return s.cache;
  const map = new Map<string, ActionAdoption>();
  const docs = await mirror.hydrate(500);
  for (const a of (docs ?? []) as ActionAdoption[]) map.set(a.id, a);
  s.cache = map;
  return map;
}

function writeThrough(a: ActionAdoption): void {
  mirror.writeThrough(a.id, a);
}

/** ALL non-revoked adoptions — the intersection's source (server-side, not user-scoped,
 *  exactly like `allActiveExposures`). */
export async function allActiveAdoptions(): Promise<ActionAdoption[]> {
  const map = await getCache();
  return [...map.values()].filter((a) => !a.revoked);
}

/** True when `domain` has a non-revoked adoption of `entityKey`'s actions for
 *  `exposureId`. The per-call intersection check — pure over the loaded cache. */
export function adoptionCovers(
  adoptions: ActionAdoption[],
  exposureId: string,
  domain: string,
  entityKey: string,
): boolean {
  const key = entityActionKey(entityKey);
  return adoptions.some(
    (a) => !a.revoked && a.exposureId === exposureId && a.domain === domain && a.entities.includes(key),
  );
}

/** The adoptions for an exposure (the adopt-panel list). Read-only; not user-scoped
 *  beyond the exposure id (an exposure a caller can't see yields no id to query). */
export async function listAdoptions(exposureId: string): Promise<ActionAdoption[]> {
  const map = await getCache();
  return [...map.values()]
    .filter((a) => a.exposureId === exposureId)
    .sort((x, y) => y.at.localeCompare(x.at));
}

/**
 * ADOPT actions for a domain — a `domain_admin` (or admin) of that domain accepts an
 * exposure's entity actions into their domain. Fail-closed: the adopter must administer
 * the target domain. Replaces any prior (non-revoked) adoption for the same
 * exposure+domain so the entity set is authoritative.
 */
export async function adoptActions(
  connId: string,
  user: CurrentUser,
  input: { exposureId: string; domain: string; entities: string[] },
): Promise<ActionAdoption> {
  const c = await getConnectionById(connId); // existence (server-side; not user-scoped)
  if (!c) throw withStatus(new Error('Connection not found'), 404);
  const domain = String(input.domain ?? '').trim();
  if (!domain) throw withStatus(new Error('An adoption needs a target domain'), 400);
  // domain_admin+ of the TARGET domain, or a tenant admin. Adoption is a domain-consent
  // act — gated on the adopter administering the TARGET domain, not on raw connection
  // visibility (a domain admin adopts an exposure shared to their domain without owning
  // the connection).
  const adminOfDomain = roleAtLeast(user.role, 'domain_admin') && user.domains.includes(domain);
  if (!adminOfDomain && !roleAtLeast(user.role, 'admin')) {
    throw withStatus(new Error('Adopting actions requires a domain administrator of the target domain'), 403);
  }
  const entities = [...new Set((input.entities ?? []).map(entityActionKey).filter(Boolean))];
  if (entities.length === 0) throw withStatus(new Error('Select at least one entity to adopt actions for'), 400);

  const map = await getCache();
  // Supersede any prior non-revoked adoption for this exposure+domain.
  for (const a of map.values()) {
    if (!a.revoked && a.exposureId === input.exposureId && a.domain === domain) {
      a.revoked = true;
      map.set(a.id, a);
      writeThrough(a);
    }
  }
  const rec: ActionAdoption = {
    id: id('adopt'),
    exposureId: input.exposureId,
    domain,
    entities,
    adoptedBy: user.id,
    at: now(),
  };
  map.set(rec.id, rec);
  writeThrough(rec);
  void trace({
    principal: `domain:${domain}`,
    tool: 'generate',
    input: { action: 'entity_actions_adopted', by: user.id, exposureId: input.exposureId, domain, entities },
    output: { adoptionId: rec.id },
    decision: 'allow',
  });
  return rec;
}

/** REVOKE (soft) a domain's action adoption. Same gate as adopt (domain_admin of the
 *  domain / admin). The action tools die immediately (intersection recomputes per call). */
export async function revokeActionAdoption(adoptionId: string, user: CurrentUser): Promise<ActionAdoption> {
  const map = await getCache();
  const a = map.get(adoptionId);
  if (!a) throw withStatus(new Error('Adoption not found'), 404);
  const adminOfDomain = roleAtLeast(user.role, 'domain_admin') && user.domains.includes(a.domain);
  if (!adminOfDomain && !roleAtLeast(user.role, 'admin')) {
    throw withStatus(new Error('Revoking an adoption requires a domain administrator of the domain'), 403);
  }
  a.revoked = true;
  map.set(a.id, a);
  writeThrough(a);
  void trace({
    principal: `domain:${a.domain}`,
    tool: 'generate',
    input: { action: 'entity_actions_adoption_revoked', by: user.id, adoptionId },
    output: { adoptionId: a.id, revoked: true },
    decision: 'allow',
  });
  return a;
}

/** Test seam — forget the in-process cache. */
export function __resetActionAdoptions(): void {
  adState().cache = null;
  mirror.__reset();
}
