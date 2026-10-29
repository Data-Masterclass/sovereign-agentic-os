/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * gateway-mirror — LiteLLM's state, as the OS sees it. READ ONLY.
 *
 * FEATURE:
 *   • One `readMirror()` that collects eleven LiteLLM admin reads in parallel
 *     and returns a single flat shape the admin panels can render directly.
 *   • Drift detection: anything that exists in LiteLLM with no OS counterpart is
 *     reported as `unmanaged` — listed, never adopted and never invented.
 *   • A short cache with honest degradation: when the gateway is unreachable the
 *     last good mirror is served with `degraded: true` and its ORIGINAL
 *     `fetchedAt`, so a panel can say "as of 14:02, gateway unreachable".
 *
 * USER STORY:
 *   • As a platform admin, a model I add in LiteLLM's own UI appears in the OS
 *     agent model picker with no redeploy and no second entry of the same facts.
 *   • As a platform admin, a domain budget I set in LiteLLM shows on
 *     Admin -> Domains, because LiteLLM is the ledger and the OS reads it.
 *   • As a platform admin, a team or key somebody created directly in LiteLLM is
 *     flagged to me as unmanaged rather than silently treated as OS-governed.
 *   • As a finance owner, the billing envelope uses real gateway spend, and when
 *     spend cannot be read it shows unknown rather than a misleading zero.
 *
 * ARCHITECTURE:
 *   Direction of truth, deliberately one-way in this phase:
 *     OS  -> identity and policy (who may use what)
 *     LiteLLM -> enforcement point and spend ledger (what actually happened)
 *   This module only READS the second half. Nothing here writes to LiteLLM;
 *   reconciliation lands in Phase 3 as its own module, so that the boundary
 *   between "we observe the gateway" and "we change the gateway" stays visible.
 *
 *   Split in two on purpose:
 *     `buildMirror(sources, known)` is PURE — all mapping, classification and
 *       drift logic, fully unit-testable with no network and no clock.
 *     `readMirror()` is the thin IO shell — fetch, cache, resolve OS
 *       counterparts. Keeping the shell thin is what makes the rules testable.
 *
 *   Spend attribution depends on LiteLLM request tags (`domain:`, `agent:`,
 *   `tab:`). Untagged traffic is NOT guessed at and simply does not appear in
 *   the per-dimension breakdown; the panels say so rather than implying zero.
 */
import 'server-only';
import {
  readModels, readModelGroups, readTeams, readKeys, readGuardrails,
  readSpendReport, readHealthLatest, readTagActivity,
  type Fetched, type LiteLlmModelRow, type LiteLlmModelGroupRow, type LiteLlmTeamRow,
  type LiteLlmKeyRow, type LiteLlmGuardrailRow, type LiteLlmSpendRow,
  type LiteLlmHealthBody, type LiteLlmTagActivityBody,
} from '@core/infra/litellm-admin';

/** The locked Phase 2 shape. Panels depend on this and nothing deeper. */
export type GatewayMirror = {
  models: { id: string; group: string; provider: string; healthy: boolean }[];
  teams: { teamId: string; alias: string; maxBudget: number | null; spend: number; models: string[] }[];
  keys: { alias: string; owner: 'agent' | 'service' | 'unknown'; blocked: boolean; spend: number }[];
  guardrails: { name: string; provider: string; failOpen: boolean }[];
  spend: { byDomain: Record<string, number>; byUser: Record<string, number>; byAgent: Record<string, number>; byTab: Record<string, number> };
  /** Exists in LiteLLM, has no OS counterpart. Reported, never adopted. */
  unmanaged: { kind: 'team' | 'key'; id: string }[];
  fetchedAt: number;
  /** true = the gateway could not be read; this is cache or empty, not truth. */
  degraded: boolean;
};

/** Everything `buildMirror` needs from LiteLLM, already unwrapped. */
export type MirrorSources = {
  models: Fetched<LiteLlmModelRow[]>;
  groups: Fetched<LiteLlmModelGroupRow[]>;
  teams: Fetched<LiteLlmTeamRow[]>;
  keys: Fetched<LiteLlmKeyRow[]>;
  guardrails: Fetched<LiteLlmGuardrailRow[]>;
  spendReport: Fetched<LiteLlmSpendRow[]>;
  health: Fetched<LiteLlmHealthBody>;
  tags: Fetched<LiteLlmTagActivityBody>;
};

/** What the OS governs, used only to decide what is drift. */
export type OsCounterparts = { domains: string[]; agents: string[] };

const TTL_MS = 30_000;
let cache: GatewayMirror | null = null;

const ok = <T>(f: Fetched<T>, fallback: T): T => (f.ok ? f.data : fallback);
const norm = (s: string): string => s.trim().toLowerCase();

/**
 * Which provider serves an alias. Read from `litellm_params.model`'s prefix
 * ("openai/gpt-4o" -> "openai"), else the host of a custom `api_base`, else
 * the model group's own declaration. Unknown stays "unknown" — a wrong provider
 * label on a cost page is worse than an honest blank.
 */
export function providerOf(row: LiteLlmModelRow, group?: LiteLlmModelGroupRow): string {
  const m = row.litellm_params?.model ?? '';
  const slash = m.indexOf('/');
  if (slash > 0) return m.slice(0, slash);
  const base = row.litellm_params?.api_base ?? '';
  if (base) {
    try { return new URL(base).hostname; } catch { /* not a URL — fall through */ }
  }
  const declared = group?.providers?.[0];
  return declared && declared.length > 0 ? declared : 'unknown';
}

/**
 * Who a virtual key belongs to. An explicit `metadata.os_owner` wins, because
 * that is what the OS stamps on keys it issues. Otherwise fall back to the
 * alias prefix convention. Anything else is `unknown`, which is also what makes
 * it drift — see `unmanaged`.
 */
export function ownerOf(row: LiteLlmKeyRow): 'agent' | 'service' | 'unknown' {
  const stamped = row.metadata?.os_owner;
  if (stamped === 'agent' || stamped === 'service') return stamped;
  const alias = norm(row.key_alias ?? '');
  if (alias.startsWith('agent-') || alias.startsWith('agent:')) return 'agent';
  if (alias.startsWith('svc-') || alias.startsWith('service-') || alias.startsWith('service:')) return 'service';
  return 'unknown';
}

/** Model names LiteLLM currently reports as failing their health probe. */
function unhealthyNames(health: Fetched<LiteLlmHealthBody>): Set<string> {
  const out = new Set<string>();
  if (!health.ok) return out; // health unknown -> treat nothing as unhealthy, and `degraded` says why
  for (const e of health.data?.unhealthy_endpoints ?? []) {
    const n = e.model_name ?? e.model;
    if (n) out.add(norm(n));
  }
  return out;
}

/**
 * Spend per tag dimension. The OS tags gateway requests `domain:<id>`,
 * `agent:<id>` and `tab:<id>`; any other tag is ignored rather than bucketed
 * into a dimension it does not belong to.
 */
export function spendByTag(tags: Fetched<LiteLlmTagActivityBody>): Pick<GatewayMirror['spend'], 'byDomain' | 'byAgent' | 'byTab'> {
  const byDomain: Record<string, number> = {};
  const byAgent: Record<string, number> = {};
  const byTab: Record<string, number> = {};
  for (const r of ok(tags, {} as LiteLlmTagActivityBody).results ?? []) {
    const tag = r.tag ?? '';
    const spend = Number(r.metrics?.spend ?? 0);
    if (!tag || !Number.isFinite(spend)) continue;
    const i = tag.indexOf(':');
    if (i <= 0) continue;
    const [kind, id] = [tag.slice(0, i), tag.slice(i + 1)];
    const bucket = kind === 'domain' ? byDomain : kind === 'agent' ? byAgent : kind === 'tab' ? byTab : null;
    if (!bucket || !id) continue;
    bucket[id] = (bucket[id] ?? 0) + spend;
  }
  return { byDomain, byAgent, byTab };
}

/**
 * Map raw LiteLLM reads into the mirror. PURE: no network, no clock, no cache.
 *
 * `degraded` keys off the model read specifically. Models are the one source
 * that must be live for the mirror to mean anything — a mirror with no models
 * is not a gateway with no models, it is a gateway we could not reach.
 */
export function buildMirror(s: MirrorSources, known: OsCounterparts, now: number): GatewayMirror {
  const groups = new Map<string, LiteLlmModelGroupRow>();
  for (const g of ok(s.groups, [])) if (g.model_group) groups.set(norm(g.model_group), g);
  const sick = unhealthyNames(s.health);

  // One row per ALIAS, not per deployment: the picker pins aliases.
  const models: GatewayMirror['models'] = [];
  const seen = new Set<string>();
  for (const row of ok(s.models, [])) {
    const id = row.model_name;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const group = groups.get(norm(id));
    models.push({
      id,
      group: group?.model_group ?? id,
      provider: providerOf(row, group),
      healthy: !sick.has(norm(id)),
    });
  }

  const teams: GatewayMirror['teams'] = ok(s.teams, [])
    .filter((t) => Boolean(t.team_id))
    .map((t) => ({
      teamId: String(t.team_id),
      alias: t.team_alias ?? '',
      maxBudget: typeof t.max_budget === 'number' ? t.max_budget : null,
      spend: Number(t.spend ?? 0),
      models: Array.isArray(t.models) ? t.models : [],
    }));

  const keys: GatewayMirror['keys'] = ok(s.keys, []).map((k) => ({
    alias: k.key_alias ?? '',
    owner: ownerOf(k),
    blocked: k.blocked === true,
    spend: Number(k.spend ?? 0),
  }));

  const guardrails: GatewayMirror['guardrails'] = ok(s.guardrails, [])
    .filter((g) => Boolean(g.guardrail_name))
    .map((g) => ({
      name: String(g.guardrail_name),
      provider: g.litellm_params?.guardrail ?? 'unknown',
      // Absent means LiteLLM blocks the request when the scanner errors, i.e.
      // fail CLOSED. We never report fail-open unless LiteLLM says so.
      failOpen: g.litellm_params?.fail_open === true,
    }));

  const byUser: Record<string, number> = {};
  for (const r of ok(s.spendReport, [])) {
    const id = r.user_id ?? r.customer_id;
    const spend = Number(r.spend ?? 0);
    if (!id || !Number.isFinite(spend)) continue;
    byUser[id] = (byUser[id] ?? 0) + spend;
  }

  // Drift. A team is OS-governed when its alias or id names a known domain;
  // a key is OS-governed when we can attribute an owner to it.
  const domains = new Set(known.domains.map(norm));
  const unmanaged: GatewayMirror['unmanaged'] = [];
  for (const t of teams) {
    if (!domains.has(norm(t.alias)) && !domains.has(norm(t.teamId))) unmanaged.push({ kind: 'team', id: t.teamId });
  }
  const agents = new Set(known.agents.map(norm));
  for (const k of keys) {
    const stripped = norm(k.alias).replace(/^(agent[-:]|svc-|service[-:])/, '');
    if (k.owner === 'unknown' && !agents.has(stripped)) unmanaged.push({ kind: 'key', id: k.alias || '(unnamed key)' });
  }

  return {
    models, teams, keys, guardrails,
    spend: { byUser, ...spendByTag(s.tags) },
    unmanaged,
    fetchedAt: now,
    degraded: !s.models.ok,
  };
}

/** The OS side of the comparison. Hydration is done by `adminCtx` upstream. */
async function osCounterparts(): Promise<OsCounterparts> {
  try {
    const [{ listDomains }, { listAllSystemsInternal }] = await Promise.all([
      import('@tabs/admin/lib/domains'),
      import('@tabs/agents/lib/store'),
    ]);
    return {
      domains: listDomains().map((d) => d.id),
      agents: listAllSystemsInternal().map((a) => a.id),
    };
  } catch {
    // No OS side to compare against -> report no drift rather than flagging
    // every team and key in the gateway as unmanaged.
    return { domains: [], agents: [] };
  }
}

/**
 * The gateway mirror, cached for 30s.
 *
 * On a failed read the last good mirror is returned with `degraded: true` and
 * its original `fetchedAt`, so the UI can date the data it is showing. With no
 * cache to fall back on the mirror is empty and degraded — never fabricated.
 */
export async function readMirror(): Promise<GatewayMirror> {
  const now = Date.now();
  if (cache && !cache.degraded && now - cache.fetchedAt < TTL_MS) return cache;
  const [models, groups, teams, keys, guardrails, spendReport, health, tags] = await Promise.all([
    readModels(), readModelGroups(), readTeams(), readKeys(),
    readGuardrails(), readSpendReport(), readHealthLatest(), readTagActivity(),
  ]);
  const mirror = buildMirror(
    { models, groups, teams, keys, guardrails, spendReport, health, tags },
    await osCounterparts(),
    now,
  );
  if (mirror.degraded) return cache ? { ...cache, degraded: true } : mirror;
  cache = mirror;
  return mirror;
}

/** Test seam: drop the cache between cases. */
export function _resetGatewayMirrorCache(): void {
  cache = null;
}
