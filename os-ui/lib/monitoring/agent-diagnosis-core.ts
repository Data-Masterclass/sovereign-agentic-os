/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { System, Schedule, ArtifactGrant } from '../agents/system-schema.ts';
import type { LastRun } from '../agents/store.ts';

/**
 * Pure core for the agent DIAGNOSIS view (Monitoring → open an agent tile).
 * Three plain-data folds that make the detail page substantive even when
 * Langfuse is thin or down, because every input already exists in-process:
 *
 *   • buildProfile   — the team's shape: nodes/roles/models, trigger mode,
 *                      runtime/safety, and its grants (ids resolved to names
 *                      via a caller-supplied, viewer-scoped lookup).
 *   • lastRunView    — the OS run store's persisted last-run report, trimmed
 *                      for the read plane (per-node status + tool steps).
 *   • toolTraceRows  — the in-process governed ring filtered to one system's
 *                      principal (`os-<id>[:node]`): time · tool · decision.
 *
 * No fetch, no stores, no `server-only` — runs under `node --test`; the detail
 * route stays a thin governed assembler.
 */

// ------------------------------------------------------------ system profile --

export type GrantKind = 'data' | 'knowledge' | 'files' | 'metrics' | 'connections';
export const GRANT_KINDS: readonly GrantKind[] = ['data', 'knowledge', 'files', 'metrics', 'connections'];

export type GrantRow = { id: string; name: string; capability: string };
export type GrantGroup = { kind: GrantKind; count: number; rows: GrantRow[] };
export type ProfileNode = {
  id: string;
  role: string;
  /** Explicit per-agent model, else the routing override, else 'auto'. */
  model: string;
  supervisor: boolean;
  entry: boolean;
  disabled: boolean;
};
export type SystemProfile = {
  runtime: string;
  safetyPreset: string;
  trigger: string;
  description?: string;
  nodes: ProfileNode[];
  tools: string[];
  grants: GrantGroup[];
};

/** Human trigger-mode label from a schedule. */
export function triggerLabel(schedule: Schedule | undefined): string {
  if (!schedule || schedule.kind === 'manual') return 'Manual';
  if (schedule.kind === 'cron') return schedule.cron ? `Scheduled · ${schedule.cron}` : 'Scheduled';
  return schedule.event ? `Event · ${schedule.event}` : 'Event';
}

function grantName(g: ArtifactGrant, lookup: (id: string) => string | undefined): string {
  // Folder grants carry a path, not an artifact id — show the path honestly.
  if (g.folder) return `${g.folder.path} (${g.folder.scope} folder)`;
  return lookup(g.id) ?? g.id; // fail-soft: an unresolvable id stays an id
}

/**
 * Fold a parsed `system.yaml` (+ the record's live schedule/disabled state) into
 * the profile block. `nameOf` must be a VIEWER-scoped lookup (built from the
 * caller's own governed lists) so grant names never leak beyond the viewer's DLS
 * — anything not visible falls back to the raw id.
 */
export function buildProfile(
  sys: System,
  opts: { disabledAgents?: readonly string[]; schedule?: Schedule },
  nameOf: (kind: GrantKind, id: string) => string | undefined,
): SystemProfile {
  const disabled = new Set(opts.disabledAgents ?? []);
  const nodes: ProfileNode[] = sys.agents.map((a) => ({
    id: a.id,
    role: a.role,
    model: a.model ?? sys.routing.overrides[a.id] ?? 'auto',
    supervisor: (a.members?.length ?? 0) > 0,
    entry: a.id === sys.entrypoint,
    disabled: disabled.has(a.id),
  }));
  const grants: GrantGroup[] = GRANT_KINDS.map((kind) => {
    const list = sys.grants[kind] ?? [];
    return {
      kind,
      count: list.length,
      rows: list.map((g) => ({
        id: g.id,
        name: grantName(g, (id) => nameOf(kind, id)),
        capability: g.capability + (g.layer ? ` · ${g.layer}` : ''),
      })),
    };
  });
  return {
    runtime: sys.runtime,
    safetyPreset: sys.safetyPreset,
    trigger: triggerLabel(opts.schedule ?? sys.schedule),
    description: sys.system.description,
    nodes,
    tools: sys.grants.tools ?? [],
    grants,
  };
}

// ----------------------------------------------------- governed tool-call trace --

/** Structural mirror of `TraceRecord` (lib/infra/agent-governed) — kept local so
 *  this module never imports the server-only ring. */
export type RingTraceLike = {
  timestamp: string;
  principal: string;
  tool: string;
  decision?: string;
  output?: unknown;
  landed?: boolean;
};

export type ToolTraceRow = {
  at: number;
  tool: string;
  /** Sub-agent node when the principal was `os-<id>:<node>`. */
  node?: string;
  decision: string;
  /** Whether the trace also landed in Langfuse (false ⇒ ring-only). */
  landed: boolean;
  /** Short error/deny context, only when something went wrong. */
  detail?: string;
};

function short(v: unknown, max = 140): string | undefined {
  if (v == null) return undefined;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (!s) return undefined;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Filter the in-process governed ring to ONE system's principal(s) and map to
 * table rows (input order preserved — the ring reader already returns newest
 * first). This exists even when Langfuse is down: it is the honest floor.
 */
export function toolTraceRows(
  traces: readonly RingTraceLike[],
  systemId: string,
  limit = 50,
): ToolTraceRow[] {
  const base = `os-${systemId}`;
  const rows: ToolTraceRow[] = [];
  for (const t of traces) {
    if (rows.length >= limit) break;
    if (t.principal !== base && !t.principal.startsWith(`${base}:`)) continue;
    const at = Date.parse(t.timestamp);
    if (!Number.isFinite(at)) continue;
    const out = typeof t.output === 'string' ? t.output : '';
    const errorish = t.decision === 'deny' || /error|fail|aborted/i.test(out);
    rows.push({
      at,
      tool: t.tool,
      node: t.principal.length > base.length ? t.principal.slice(base.length + 1) : undefined,
      decision: t.decision ?? '—',
      landed: t.landed ?? false,
      detail: errorish ? short(t.output) : undefined,
    });
  }
  return rows;
}

// ------------------------------------------------------------ last-run report --

export type RunStepView = { tool: string; isError: boolean; summary?: string };
export type RunNodeView = {
  node: string;
  model?: string;
  tier?: string;
  tierReason?: string;
  status: string;
  error?: string;
  input?: string;
  finalText?: string;
  steps: RunStepView[];
};
export type LastRunReport = {
  at: number;
  ok: boolean;
  running: boolean;
  /** How the run was triggered/executed, e.g. 'interactive' or 'interactive · offline-mock'. */
  trigger: string;
  path: string[];
  held: number;
  output?: string;
  nodes: RunNodeView[];
};

/**
 * Trim the OS run store's persisted `lastRun` into the read-plane report:
 * outcome + routing path + per-node drill-down (status, model tier, tool steps).
 * Long texts are truncated — this is a diagnosis view, not an archive.
 */
export function lastRunReport(run: LastRun | null | undefined): LastRunReport | null {
  if (!run) return null;
  return {
    at: run.at,
    ok: run.ok,
    running: run.running,
    trigger: run.mode === 'offline-mock' ? 'interactive · offline-mock' : 'interactive',
    path: run.path ?? [],
    held: run.held ?? 0,
    output: short(run.output, 2000),
    nodes: (run.nodes ?? []).map((n) => ({
      node: n.node,
      model: n.model,
      tier: n.tier,
      tierReason: n.tierReason,
      status: n.status,
      error: n.error,
      input: short(n.input, 400),
      finalText: short(n.finalText, 2000),
      steps: (n.steps ?? []).map((s) => ({ tool: s.tool, isError: !!s.isError, summary: s.summary })),
    })),
  };
}
