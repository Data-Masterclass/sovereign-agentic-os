/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/config';
import { grantsFor as appGrantsFor } from '@/lib/app-registry';
import {
  compileConnectionProfile,
  decide,
  exposedTools,
  type OpaConnectionBundle,
  type CapMode,
} from '@/lib/capability-compiler';

/**
 * Governed agent-tool spine (Agent golden path §1, §7). Every tool an agent
 * calls — `metrics`, `retrieve`, the connection proxy, `write_file` — funnels
 * through `authorize()` + `trace()` here, so the SAME OPA decision + Langfuse
 * audit applies to the Sales Assistant as to any other caller. This mirrors the
 * Data golden path's `lib/governed.ts` spine but is kept in its own file so the
 * two branches merge cleanly; it ALSO understands the richer
 * `allow / deny / requires_approval` decision the agent layer needs (the data
 * spine only needs allow/deny).
 *
 *   1. OPA authorization — we ask the live decision API for the effect. OPA is
 *      off locally, so we fail OPEN with an explicit `opa-unreachable` marker and
 *      a built-in policy mirror (so the teaching flow + the approval gate still
 *      work offline, honestly reported).
 *   2. Best-effort Langfuse trace + an in-process ring buffer so every governed
 *      tool call is auditable in Monitoring even with no live Langfuse.
 */

export type ToolName =
  | 'metrics'
  | 'retrieve'
  // Governed hybrid retrieval over the Files tab's `files` index (Files golden
  // path §5). DLS-scoped to what the delegated user may see; cites the file.
  | 'files_retrieve'
  | 'connection_crm_read'
  | 'connection_crm_write'
  | 'write_file'
  | 'knowledge_certify'
  | 'web_fetch'
  // Layer-4 (Science): a deployed ML model exposed as a governed MCP tool. The
  // Sales Assistant calls `predict` to flag at-risk accounts (churn slice §7).
  | 'predict';

export type Effect = 'allow' | 'deny' | 'requires_approval';
export type Policy =
  | 'opa-allow'
  | 'opa-deny'
  | 'opa-requires-approval'
  | 'opa-unreachable'
  // A dynamically-registered app MCP grant (Software golden path §4): the tool
  // belongs to an auto-generated app connection, not the static chart grants.
  | 'app-grant';

export type Authz = { effect: Effect; policy: Policy; reason: string };

/**
 * Offline policy mirror (§7 baseline). Used ONLY when OPA is unreachable so the
 * default-deny posture + the approval gate are still demonstrable on a laptop
 * with no cluster. The live source of truth is OPA (`opa.grants` +
 * `opa.requiresApproval` in the chart).
 */
const LOCAL_GRANTS: Record<string, ToolName[]> = {
  // The canonical governed-agent principal (a scoped LiteLLM key / Ory identity).
  // It is the default MCP `predict`/tools caller used by the Science + Agents
  // governance demos — NOT a worked-example agent.
  'sales-assistant': [
    'metrics',
    'retrieve',
    'files_retrieve', // governed hybrid retrieval over the Files index (Files §5)
    'connection_crm_read',
    'connection_crm_write',
    'write_file',
    'knowledge_certify',
    'predict', // consume the deployed churn model (Science golden path §7)
  ],
  // The deployed churn model's own principal (the `predict` MCP tool identity).
  'churn-model': ['predict'],
  // The "Churn Risk" Software app — the REST `predict` front-door caller
  // (Software golden path §7). Granted predict like any other governed tool, so
  // the same OPA gate applies whether the caller is an app (REST) or an agent (MCP).
  'churn-risk-app': ['predict'],
  // Domain principals (the data spine's grant unit) keep read tools.
  sales: ['metrics', 'retrieve', 'files_retrieve', 'connection_crm_read', 'write_file'],
  finance: ['metrics', 'retrieve', 'files_retrieve'],
};

/** High-stakes tools that are paused for human approval even when granted (§7). */
const LOCAL_REQUIRES_APPROVAL: ToolName[] = [
  'connection_crm_write',
  'knowledge_certify',
];

async function withTimeout(url: string, init: RequestInit, ms = 2500): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function localDecision(principal: string, tool: ToolName): Authz {
  const granted = (LOCAL_GRANTS[principal] ?? []).includes(tool);
  if (!granted) {
    return { effect: 'deny', policy: 'opa-unreachable', reason: `${principal} is not granted ${tool}` };
  }
  if (LOCAL_REQUIRES_APPROVAL.includes(tool)) {
    return { effect: 'requires_approval', policy: 'opa-unreachable', reason: `${tool} is high-stakes — human approval required` };
  }
  return { effect: 'allow', policy: 'opa-unreachable', reason: 'granted' };
}

/**
 * Ask OPA for the rich decision (`allow` / `deny` / `requires_approval`). Falls
 * back to the built-in mirror, clearly marked, when OPA is off.
 */
export async function authorize(principal: string, tool: ToolName): Promise<Authz> {
  const res = await withTimeout(`${config.opaUrl}/v1/data/agentic/authz/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: { principal, tool } }),
  });
  if (!res) return localDecision(principal, tool);
  try {
    const data = (await res.json()) as { result?: { effect?: Effect; reason?: string } };
    const effect = data?.result?.effect;
    if (effect === 'allow') return { effect, policy: 'opa-allow', reason: data.result?.reason ?? 'granted' };
    if (effect === 'requires_approval')
      return { effect, policy: 'opa-requires-approval', reason: data.result?.reason ?? 'approval required' };
    if (effect === 'deny') return { effect, policy: 'opa-deny', reason: data.result?.reason ?? 'denied' };
    // Old OPA without the decision rule -> use the mirror but keep it honest.
    return localDecision(principal, tool);
  } catch {
    return localDecision(principal, tool);
  }
}

/**
 * Authorize a call to an AUTO-GENERATED APP MCP tool (Software golden path §4).
 * App tool names are dynamic (`list_renewals`, `add_renewal`, …) and their
 * grants live in the in-process app-registry, not the static chart `opa.grants`,
 * so we resolve them there first. If the app principal has no dynamic grant we
 * fall back to the OPA decision API for completeness (and honest default-deny).
 */
export async function authorizeAppTool(principal: string, tool: string): Promise<Authz> {
  if (appGrantsFor(principal).includes(tool)) {
    return { effect: 'allow', policy: 'app-grant', reason: 'granted by the app MCP connection' };
  }
  // Not a known app grant — ask OPA (will deny offline unless statically granted).
  return authorize(principal, tool as ToolName);
}

// ------------------------------------------- Connection capability profiles ----

/**
 * Connections golden path §3/§7 — the OFFLINE MIRROR of a connection's compiled
 * OPA policy. When a Builder/Admin creates a connection and sets its per-tool
 * capability profile (Off / Read / Write-approval / Write-bounded / Blocked +
 * limits), `lib/connections.ts` compiles that profile into the connection's OPA
 * policy data AND registers it here, so the SAME gate is demonstrable on a laptop
 * with no live OPA. Only enabled, in-scope tools are exposed; a grant to a
 * specific agent can FURTHER RESTRICT (never broaden).
 */
export type ConnMode = CapMode;

export type ConnToolPolicy = {
  name: string;
  mode: ConnMode;
  write: boolean;
  /** Bounded-write argument constraint (e.g. amount ≤ maxAmount). */
  maxAmount?: number;
  dataScope?: string;
};

/**
 * THE ONE RULE: a connection's compiled OPA data bundle. We store the bundle the
 * `lib/capability-compiler.ts` produces and evaluate calls with the SAME
 * `decide()` a live OPA would run against it — so the offline mirror and the
 * online policy cannot drift. The per-agent grant lives inside the bundle.
 */
const CONNECTION_BUNDLES = new Map<string, OpaConnectionBundle>();

/** Compile + register (or replace) a connection's capability profile. */
export function registerConnectionProfile(principal: string, tools: ConnToolPolicy[]): void {
  CONNECTION_BUNDLES.set(
    principal,
    compileConnectionProfile(
      principal,
      tools.map((t) => ({ name: t.name, mode: t.mode, write: t.write, maxAmount: t.maxAmount, dataScope: t.dataScope })),
    ),
  );
}

export function unregisterConnectionProfile(principal: string): void {
  CONNECTION_BUNDLES.delete(principal);
}

/** The compiled bundle for a principal (for pushing to OPA / inspection). */
export function connectionBundle(principal: string): OpaConnectionBundle | null {
  return CONNECTION_BUNDLES.get(principal) ?? null;
}

/** Tool names actually exposed to an agent (enabled + in-scope; not Off/Blocked). */
export function exposedConnectionTools(principal: string): string[] {
  const b = CONNECTION_BUNDLES.get(principal);
  return b ? exposedTools(b) : [];
}

/**
 * Grant a connection to a specific agent, FURTHER RESTRICTED to `allowedTools`
 * (e.g. read-only). The grant is compiled into the bundle, so the intersection is
 * enforced by the same `decide()` — a grant can only narrow, never broaden.
 */
export function restrictConnectionForAgent(
  agentPrincipal: string,
  connectionPrincipal: string,
  allowedTools: string[],
): void {
  const b = CONNECTION_BUNDLES.get(connectionPrincipal);
  if (!b) return;
  b.grants[agentPrincipal] = [...allowedTools];
}

export type ConnAuthz = { effect: Effect; reason: string; mode?: ConnMode };

/**
 * The governed gate for a connection tool call — delegates to the compiler's
 * `decide()` (the one rule). Off/Blocked deny, Read allow, Write-approval holds,
 * Write-bounded allows within the limit and denies outside it; an `asAgent` grant
 * further restricts.
 */
export function authorizeConnectionCall(
  connectionPrincipal: string,
  tool: string,
  args?: Record<string, unknown>,
  asAgent?: string,
): ConnAuthz {
  const b = CONNECTION_BUNDLES.get(connectionPrincipal);
  if (!b) return { effect: 'deny', reason: `unknown connection principal ${connectionPrincipal}` };
  const d = decide(b, tool, args ?? {}, asAgent);
  return { effect: d.effect, reason: d.reason, mode: d.mode };
}

// ------------------------------------------------------------- Langfuse trace --

export type TraceEvent = {
  principal: string;
  tool: ToolName | 'supervisor' | 'generate' | string;
  input: unknown;
  output: unknown;
  decision?: Effect;
  costUsd?: number;
};

export type TraceRecord = TraceEvent & { id: string; timestamp: string; landed: boolean };

// In-process ring buffer so Monitoring shows agent traces even with no Langfuse.
const RING: TraceRecord[] = [];
const RING_MAX = 200;

export function recentTraces(limit = 50): TraceRecord[] {
  return RING.slice(-limit).reverse();
}

export async function trace(event: TraceEvent): Promise<TraceRecord> {
  const id = `os-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const timestamp = new Date().toISOString();
  const auth =
    'Basic ' +
    Buffer.from(`${config.langfusePublicKey}:${config.langfuseSecretKey}`).toString('base64');
  const body = {
    batch: [
      {
        id,
        type: 'trace-create',
        timestamp,
        body: {
          id,
          name: `agent.${event.tool}`,
          metadata: { principal: event.principal, tool: event.tool, decision: event.decision, costUsd: event.costUsd },
          input: event.input,
          output: event.output,
          tags: ['agent-golden-path', `tool:${event.tool}`, ...(event.decision ? [`decision:${event.decision}`] : [])],
        },
      },
    ],
  };
  const res = await withTimeout(`${config.langfuseUrl}/api/public/ingestion`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: auth },
    body: JSON.stringify(body),
  });
  const rec: TraceRecord = { ...event, id, timestamp, landed: Boolean(res && res.ok) };
  RING.push(rec);
  if (RING.length > RING_MAX) RING.splice(0, RING.length - RING_MAX);
  return rec;
}

// ------------------------------------------- Governed metrics/retrieve facts --

/**
 * Neutral reference facts for the governed `metrics`/`retrieve` tool doors (the
 * agent-side mirror of the data spine). The `metrics` tool reads the SAME Cube
 * `daily_revenue` measure the Sales dashboard (`/api/metrics`) uses, so a tool
 * answer can't drift from the dashboard's. When Cube is off we fall back to a
 * deterministic seed and say so, rather than failing the offline-mock flow. No
 * customer/worked-example content is baked in here.
 */
export const SALES = {
  principal: 'sales-assistant',
  domain: 'sales',
  revenueMeasure: 'daily_revenue.total_revenue',
  ordersMeasure: 'daily_revenue.total_orders',
  dateDim: 'daily_revenue.order_date',
  lastQuarter: { label: 'Q1 2026', start: '2026-01-01', end: '2026-03-31' },
  // Deterministic offline seed = what the local Cube serves for Q1 2026.
  seed: { revenue: 48250, orders: 19 },
} as const;

export type MetricsResult = { value: number; source: 'cube' | 'seed-offline'; measure: string };

/** The governed `metrics` tool: resolve a scalar from the same Cube the BI uses. */
export async function metricsTool(measure: string): Promise<MetricsResult> {
  const query = {
    measures: [measure],
    timeDimensions: [
      { dimension: SALES.dateDim, granularity: 'day', dateRange: [SALES.lastQuarter.start, SALES.lastQuarter.end] },
    ],
  };
  const res = await withTimeout(
    `${config.cubeUrl}/cubejs-api/v1/load`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query }),
    },
    8000,
  );
  if (res && res.ok) {
    try {
      const data = JSON.parse(await res.text());
      const rows: Record<string, unknown>[] = Array.isArray(data?.data) ? data.data : [];
      let total = 0;
      for (const r of rows) {
        const v = Number(r[measure]);
        if (!Number.isNaN(v)) total += v;
      }
      return { value: total, source: 'cube', measure };
    } catch {
      /* fall through to seed */
    }
  }
  const seed = measure.includes('orders') ? SALES.seed.orders : SALES.seed.revenue;
  return { value: seed, source: 'seed-offline', measure };
}

export type Passage = { source: string; title: string; text: string; certified: boolean };

/**
 * The governed `retrieve` (RAG) tool: lexical search over the domain OpenSearch
 * index, with a curated offline fallback so the tool door still returns a
 * governed, certified passage on a laptop with no live OpenSearch. No
 * customer/worked-example content is baked in.
 */
const RETRIEVE_SEED: Passage[] = [
  {
    source: 'knowledge:discount-policy',
    title: 'Discount Policy (Certified)',
    text: 'Standard renewals may offer 5–10% off list. Multi-year commitments may go up to 15%. Anything beyond 15% requires Builder approval.',
    certified: true,
  },
];

export async function retrieveTool(query: string): Promise<Passage[]> {
  const body = {
    size: 4,
    _source: { excludes: ['embedding'] },
    query: { multi_match: { query, fields: ['title^2', 'text'], type: 'best_fields', fuzziness: 'AUTO' } },
  };
  const res = await withTimeout(`${config.opensearchUrl}/${config.knowledgeIndex}/_search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (res && res.ok) {
    try {
      const data = JSON.parse(await res.text());
      const hits = Array.isArray(data?.hits?.hits) ? data.hits.hits : [];
      if (hits.length > 0) {
        return hits.map((h: Record<string, unknown>) => {
          const src = (h._source ?? {}) as Record<string, unknown>;
          return {
            source: `knowledge:${String(h._id ?? '')}`,
            title: String(src.title ?? '(untitled)'),
            text: String(src.text ?? src.content ?? ''),
            certified: Boolean(src.certified),
          };
        });
      }
    } catch {
      /* fall through to seed */
    }
  }
  // Offline curated passages — keep only the ones that match the query loosely.
  const q = query.toLowerCase();
  const matched = RETRIEVE_SEED.filter(
    (p) => q.length === 0 || /contract|renew|discount|policy|term/.test(q),
  );
  return matched.length > 0 ? matched : RETRIEVE_SEED;
}
