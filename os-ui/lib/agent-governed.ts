/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/config';
import { grantsFor as appGrantsFor } from '@/lib/app-registry';

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
  // The Sales Assistant's scoped LiteLLM key / Ory identity.
  'sales-assistant': [
    'metrics',
    'retrieve',
    'connection_crm_read',
    'connection_crm_write',
    'write_file',
    'knowledge_certify',
    'predict', // consume the deployed churn model (Science golden path §7)
  ],
  // The deployed churn model's own principal (the `predict` MCP tool identity).
  'churn-model': ['predict'],
  // Domain principals (the data spine's grant unit) keep read tools.
  sales: ['metrics', 'retrieve', 'connection_crm_read', 'write_file'],
  finance: ['metrics', 'retrieve'],
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
export type ConnMode = 'Off' | 'Read' | 'Write-approval' | 'Write-bounded' | 'Blocked';

export type ConnToolPolicy = {
  name: string;
  mode: ConnMode;
  write: boolean;
  /** Bounded-write argument constraint (e.g. amount ≤ maxAmount). */
  maxAmount?: number;
  dataScope?: string;
};

// connection principal -> (tool name -> policy). The dynamic per-connection OPA data.
const CONNECTION_PROFILES = new Map<string, Map<string, ConnToolPolicy>>();
// agent principal -> (connection principal -> allowed tool names). Restrict-only.
const CONNECTION_AGENT_RESTRICTIONS = new Map<string, Map<string, Set<string>>>();

/** Compile + register (or replace) a connection's capability profile. */
export function registerConnectionProfile(principal: string, tools: ConnToolPolicy[]): void {
  const m = new Map<string, ConnToolPolicy>();
  for (const t of tools) m.set(t.name, t);
  CONNECTION_PROFILES.set(principal, m);
}

export function unregisterConnectionProfile(principal: string): void {
  CONNECTION_PROFILES.delete(principal);
}

/** Tool names actually exposed to an agent (enabled + in-scope; not Off/Blocked). */
export function exposedConnectionTools(principal: string): string[] {
  const m = CONNECTION_PROFILES.get(principal);
  if (!m) return [];
  return [...m.values()]
    .filter((p) => p.mode === 'Read' || p.mode === 'Write-approval' || p.mode === 'Write-bounded')
    .map((p) => p.name);
}

/**
 * Grant a connection to a specific agent, FURTHER RESTRICTED to `allowedTools`
 * (e.g. read-only). The intersection with the profile is enforced at call time,
 * so a grant can only narrow, never broaden, the connection's own policy.
 */
export function restrictConnectionForAgent(
  agentPrincipal: string,
  connectionPrincipal: string,
  allowedTools: string[],
): void {
  let byConn = CONNECTION_AGENT_RESTRICTIONS.get(agentPrincipal);
  if (!byConn) {
    byConn = new Map<string, Set<string>>();
    CONNECTION_AGENT_RESTRICTIONS.set(agentPrincipal, byConn);
  }
  byConn.set(connectionPrincipal, new Set(allowedTools));
}

export type ConnAuthz = { effect: Effect; reason: string; mode?: ConnMode };

/**
 * The governed gate for a connection tool call. Honors the compiled capability
 * profile and any per-agent restriction:
 *   • unknown / Off  -> deny (not exposed)
 *   • Blocked        -> deny (forbidden; needs Admin override)
 *   • Read           -> allow
 *   • Write-approval -> requires_approval (held in the Governance queue)
 *   • Write-bounded  -> allow within the limit, deny outside it
 * When `asAgent` is set, the tool must also be inside that agent's grant.
 */
export function authorizeConnectionCall(
  connectionPrincipal: string,
  tool: string,
  args?: Record<string, unknown>,
  asAgent?: string,
): ConnAuthz {
  const profile = CONNECTION_PROFILES.get(connectionPrincipal);
  if (!profile) return { effect: 'deny', reason: `unknown connection principal ${connectionPrincipal}` };
  const pol = profile.get(tool);
  if (!pol) return { effect: 'deny', reason: `tool ${tool} is not exposed by this connection` };

  // A grant to a specific agent further restricts (never broadens).
  if (asAgent) {
    const allowed = CONNECTION_AGENT_RESTRICTIONS.get(asAgent)?.get(connectionPrincipal);
    if (allowed && !allowed.has(tool)) {
      return {
        effect: 'deny',
        reason: `agent ${asAgent} is granted a narrower scope; ${tool} is not in the grant`,
        mode: pol.mode,
      };
    }
  }

  switch (pol.mode) {
    case 'Off':
      return { effect: 'deny', reason: `${tool} is Off — not exposed`, mode: 'Off' };
    case 'Blocked':
      return { effect: 'deny', reason: `${tool} is Blocked — forbidden (needs an Admin override)`, mode: 'Blocked' };
    case 'Read':
      return { effect: 'allow', reason: 'read — granted', mode: 'Read' };
    case 'Write-approval':
      return { effect: 'requires_approval', reason: `${tool} is a write — held for human approval`, mode: 'Write-approval' };
    case 'Write-bounded': {
      const amount = Number((args ?? {}).amount);
      if (pol.maxAmount !== undefined) {
        if (!Number.isFinite(amount)) {
          return { effect: 'deny', reason: `bounded write requires a numeric amount ≤ ${pol.maxAmount}`, mode: 'Write-bounded' };
        }
        if (amount > pol.maxAmount) {
          return { effect: 'deny', reason: `amount ${amount} exceeds the bound (≤ ${pol.maxAmount})`, mode: 'Write-bounded' };
        }
      }
      return { effect: 'allow', reason: `within bound${pol.maxAmount !== undefined ? ` (≤ ${pol.maxAmount})` : ''}`, mode: 'Write-bounded' };
    }
    default:
      return { effect: 'deny', reason: 'unknown mode' };
  }
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

// --------------------------------------------------- Sales worked-example facts --

/**
 * Canonical Sales Assistant facts (golden path §10). The `metrics` tool reads the
 * SAME Cube `daily_revenue` measure the Sales dashboard (`/api/metrics`) uses, so
 * the email's number can't drift from the dashboard's. When Cube is off we fall
 * back to a deterministic seed (the same figures the local Cube would serve) and
 * say so, rather than failing the teaching flow.
 */
export const SALES = {
  principal: 'sales-assistant',
  domain: 'sales',
  model: config.litellmChatModel,
  cube: 'daily_revenue',
  revenueMeasure: 'daily_revenue.total_revenue',
  ordersMeasure: 'daily_revenue.total_orders',
  dateDim: 'daily_revenue.order_date',
  lastQuarter: { label: 'Q1 2026', start: '2026-01-01', end: '2026-03-31' },
  account: 'ACME',
  // Deterministic offline seed = what the local Cube serves for Q1 2026.
  seed: { revenue: 48250, orders: 19 },
  // Allowed discount bands from the Discount Policy knowledge base (§10.3).
  discountBands: { renewal: '5–10%', multiYear: 'up to 15%' },
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
 * index, with a curated offline fallback so the Sales Assistant always has its
 * contract + discount-policy passages on a laptop.
 */
const RETRIEVE_SEED: Passage[] = [
  {
    source: 'file:acme-contract.pdf',
    title: 'ACME master agreement — renewal terms',
    text: 'Initial term 12 months, auto-renews unless cancelled 30 days prior. Renewal price uplift capped at CPI. Account owner signature required.',
    certified: false,
  },
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
    (p) => q.length === 0 || p.title.toLowerCase().includes('') || /contract|renew|discount|policy|acme|term/.test(q),
  );
  return matched.length > 0 ? matched : RETRIEVE_SEED;
}
