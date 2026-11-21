/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Read data-product state from Dagster and its repo-sync gate, never from an OS ledger (WP-16)
 * USER STORY: As a data engineer I want the Sync, Quality and Monitoring panels to show what dbt and
 *             Dagster themselves say about my commit and my assets — dbt's own parse error, Dagster's
 *             own asset health — so the OS can never show a status the tools do not hold.
 * ARCHITECTURE:
 *   - `repoStatus` / `repoVerdict` / `repoManifest`: repo-sync's read-only feed on the code-server
 *     pod (`GET /status.json`, `/verdicts/<domain>/<sha>.json`,
 *     `/manifests/<domain>/<sha>/{manifest,semantic_manifest}.json`, images/extensions/dagster/
 *     repo-sync.sh), through Service `dagster-repo-status` (design 01 M2; 10 F6). repo-sync is the
 *     single dbt gate (10 F10): the verdict is the one its real `dbt parse` produced.
 *   - `assetHealth`: Dagster GraphQL `assetNodeOrError(assetKey)`: the latest materialization and
 *     each asset check's execution for it, named as a colour (OSS has no `assetHealth` rollup).
 *   - The `Fetched` contract (design 00 §8.2): unreachable, refused, unknown and malformed are
 *     reasons, never an empty or green value.
 */
import { config } from '@core/kernel/config';
import type { Fetched, FetchedFailure } from '@core/adapters/_contract';

const now = () => new Date().toISOString();
const fail = (reason: FetchedFailure, detail: string): Fetched<never> => ({ ok: false, reason, detail, at: now() });
const ok = <T>(value: T): Fetched<T> => ({ ok: true, value, at: now() });

const DOMAIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA = /^[0-9a-f]{40}$/;

export type RepoDomainStatus = {
  domain: string;
  head: string | null;
  current: string | null;
  lastGood: string | null;
  error: string | null;
  errorSummary: string | null;
  parsedAt: string | null;
  checkedAt: string | null;
};
export type RepoVerdict = { ok: boolean; error?: string; errorSummary?: string; parsedAt?: string };
export type ManifestName = 'manifest.json' | 'semantic_manifest.json';

type Deps = { fetch?: typeof fetch; url?: string; token?: string; timeoutMs?: number };

async function feed(path: string, deps: Deps): Promise<Fetched<unknown | null>> {
  const base = deps.url ?? config.dagsterRepoStatusUrl;
  if (!base) return fail('unreachable', 'the repo-sync feed is not configured (DAGSTER_REPO_STATUS_URL)');
  const token = deps.token ?? config.agentRuntimeToken;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? 4000);
  try {
    const res = await (deps.fetch ?? fetch)(`${base}${path}`, {
      headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      cache: 'no-store',
      signal: ctrl.signal,
    });
    if (res.status === 404) return ok(null);
    if (res.status === 401) return fail('unauthorized', `repo-sync refused the bearer (${path})`);
    if (!res.ok) return fail('invalid', `repo-sync answered HTTP ${res.status} (${path})`);
    try {
      return ok((await res.json()) as unknown);
    } catch (e) {
      return fail('invalid', `repo-sync sent no JSON for ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  } catch (e) {
    const timeout = e instanceof Error && e.name === 'AbortError';
    return fail(timeout ? 'timeout' : 'unreachable', `repo-sync ${path}: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Every domain's gate state: head, the commit Dagster runs (`current`), dbt's error. */
export async function repoStatus(deps: Deps = {}): Promise<Fetched<Record<string, RepoDomainStatus>>> {
  const r = await feed('/status.json', deps);
  if (!r.ok) return r;
  const doc = r.value as { enabled?: boolean; domains?: Record<string, RepoDomainStatus> } | null;
  if (!doc || typeof doc !== 'object' || typeof doc.domains !== 'object') return fail('invalid', 'status.json has no domains object');
  if (doc.enabled === false) return fail('unreachable', 'repo-sync is disabled on this install (REPO_SYNC_ENABLED)');
  return ok(doc.domains ?? {});
}

/** dbt's verdict for one commit; null when repo-sync has not parsed it (yet). */
export async function repoVerdict(domain: string, sha: string, deps: Deps = {}): Promise<Fetched<RepoVerdict | null>> {
  if (!DOMAIN.test(domain) || !SHA.test(sha)) return fail('invalid', 'not a domain name and a full commit sha');
  const r = await feed(`/verdicts/${domain}/${sha}.json`, deps);
  if (!r.ok) return r;
  const v = r.value as RepoVerdict | null;
  if (v !== null && typeof v?.ok !== 'boolean') return fail('invalid', `verdict for ${domain}@${sha.slice(0, 7)} has no ok field`);
  return ok(v);
}

/** dbt's own artifact for a commit that parsed (the one Dagster runs, or the previous good one). */
export async function repoManifest(domain: string, sha: string, name: ManifestName, deps: Deps = {}): Promise<Fetched<Record<string, unknown> | null>> {
  if (!DOMAIN.test(domain) || !SHA.test(sha)) return fail('invalid', 'not a domain name and a full commit sha');
  const r = await feed(`/manifests/${domain}/${sha}/${name}`, deps);
  if (!r.ok) return r;
  if (r.value !== null && (typeof r.value !== 'object' || Array.isArray(r.value))) return fail('invalid', `${name} is not a JSON object`);
  return ok(r.value as Record<string, unknown> | null);
}

// ------------------------------------------------------------------------- asset health --
//
// Dagster OSS 1.13 does not serve `Asset.assetHealth`: `DagsterInstance.
// dagster_asset_health_queries_supported()` returns False (dagster/_core/instance/methods/
// asset_methods.py), so the field is null — it is a Dagster+ feature. The colour is therefore read
// from what OSS DOES report for the asset: each asset check's execution for the latest
// materialization (`status`, and the check's `severity` when it failed) and whether it has
// materialized at all. Nothing is evaluated by the OS; it only names Dagster's own statuses.

export type CheckStatus = 'SUCCEEDED' | 'FAILED' | 'IN_PROGRESS' | 'EXECUTION_FAILED' | 'SKIPPED';
export type Colour = 'green' | 'amber' | 'red' | 'grey';
export type AssetHealth = {
  colour: Colour;
  materialized: boolean;
  checks: { name: string; status: CheckStatus | null; severity: 'ERROR' | 'WARN' | null }[];
};

/** Dagster's check results → the panel colour (red: an ERROR check failed or could not run). */
export function colourOf(h: Omit<AssetHealth, 'colour'>): Colour {
  if (h.checks.some((c) => (c.status === 'FAILED' && c.severity !== 'WARN') || c.status === 'EXECUTION_FAILED')) return 'red';
  if (h.checks.some((c) => c.status === 'FAILED')) return 'amber';
  if (!h.materialized) return 'grey';
  return h.checks.every((c) => c.status === 'SUCCEEDED') ? 'green' : 'grey';
}

const ASSET_HEALTH = `query AssetHealth($key: AssetKeyInput!) { assetNodeOrError(assetKey: $key) { __typename
  ... on AssetNode { assetMaterializations(limit: 1) { timestamp }
    assetChecksOrError { __typename ... on AssetChecks { checks { name
      executionForLatestMaterialization { status evaluation { severity } } } } } }
  ... on AssetNotFoundError { message } } }`;

export async function assetHealth(key: string[], deps: Omit<Deps, 'token'> = {}): Promise<Fetched<AssetHealth | null>> {
  const base = deps.url ?? config.dagsterUrl;
  if (!base) return fail('unreachable', 'Dagster is not configured');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? 4000);
  try {
    const res = await (deps.fetch ?? fetch)(`${base}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query: ASSET_HEALTH, variables: { key: { path: key } } }),
      cache: 'no-store',
      signal: ctrl.signal,
    });
    let body: { data?: { assetNodeOrError?: Record<string, unknown> }; errors?: { message?: string }[] };
    try {
      body = (await res.json()) as typeof body;
    } catch (e) {
      return fail('invalid', `Dagster answered HTTP ${res.status} without JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (body.errors?.length) return fail('invalid', body.errors.map((e) => e.message ?? '').join('; '));
    if (!res.ok) return fail('invalid', `Dagster answered HTTP ${res.status}`);
    const n = body.data?.assetNodeOrError ?? {};
    if (n.__typename === 'AssetNotFoundError') return ok(null);
    if (n.__typename !== 'AssetNode') return fail('invalid', `Dagster returned ${String(n.__typename)}`);
    const ac = n.assetChecksOrError as { __typename?: string; checks?: { name: string; executionForLatestMaterialization: { status: CheckStatus; evaluation: { severity: 'ERROR' | 'WARN' } | null } | null }[] } | undefined;
    if (ac?.__typename !== 'AssetChecks') return fail('invalid', `asset checks unavailable: ${String(ac?.__typename)}`);
    const h = {
      materialized: ((n.assetMaterializations as unknown[] | undefined) ?? []).length > 0,
      checks: (ac.checks ?? []).map((c) => ({
        name: c.name,
        status: c.executionForLatestMaterialization?.status ?? null,
        severity: c.executionForLatestMaterialization?.evaluation?.severity ?? null,
      })),
    };
    return ok({ colour: colourOf(h), ...h });
  } catch (e) {
    const timeout = e instanceof Error && e.name === 'AbortError';
    return fail(timeout ? 'timeout' : 'unreachable', `Dagster: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}
