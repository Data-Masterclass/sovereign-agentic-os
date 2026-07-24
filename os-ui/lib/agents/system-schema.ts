/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import yaml from 'js-yaml';
import { roleAtLeast, type Role } from '../core/session';

/**
 * `system.yaml` — the SINGLE source of truth for an agent system (Agents tab,
 * Approach A). Files in Forgejo are authoritative; this module turns the YAML
 * text into a normalized {@link System} (and back), applying the locked defaults
 * (state `{messages: add_messages}`, empty grants, empty routing overrides).
 *
 * It is intentionally a PURE module — no server-only imports, no network — so the
 * compiler, the canvas, the Monaco panel and the unit tests all share it. Graph
 * SEMANTICS (entrypoint known, no dangling edges, narrow-only tools) live in
 * `langgraph-compile.ts`; this module only validates document SHAPE.
 */

export type Visibility = 'Personal' | 'Shared' | 'Marketplace';
export type EdgeType = 'supervise' | 'handoff';
/**
 * The execution engine for a system. `langgraph` = structured, governed,
 * human-in-the-loop graphs (the default). `hermes` = the autonomous Hermes
 * runtime (long-running, persistent memory + self-improving skills). BOTH consume
 * the same governed Platform-MCP plane (OPA/LiteLLM/egress) — Hermes gets no side
 * door (hermes-agent-integration-plan.md). Gated OFF by default in the chart.
 */
export type Runtime = 'langgraph' | 'hermes';
/**
 * Safety preset (shared by both runtimes' UI). For `hermes` it maps to the
 * profile provisioner's approvals.mode + tools.include; for `langgraph` it drives
 * the same two-mode write-back governance.
 */
export type SafetyPreset = 'read-only' | 'read-propose' | 'read-bounded' | 'full-in-scope';
/** Connection capability profile (mirrors lib/agent-governed `ConnMode`). */
export type Capability = 'Off' | 'Read' | 'Write-approval' | 'Write-bounded' | 'Blocked';

/**
 * Which medallion refinement layer a DATA grant reads. `gold` is the curated
 * serving default (and the historic behaviour), so it is OMITTED on serialize and
 * ASSUMED on parse — existing system.yaml stays byte-stable. Only DATA grants carry
 * this; knowledge/metrics/connections have no layers.
 */
export type DataLayer = 'bronze' | 'silver' | 'gold';
export const DATA_LAYERS: DataLayer[] = ['bronze', 'silver', 'gold'];

/**
 * A FOLDER grant target — grants EVERY item currently under `path` in the given
 * scope tree (personal · domain), late-bound at run time by the folder-grant kernel
 * (`lib/core/folders.resolveFolderGrant`). Present ONLY on a folder grant; an item
 * grant leaves it undefined and carries a real `id`.
 */
export type FolderGrantTarget = { path: string; scope: 'personal' | 'domain' };

/**
 * A per-artifact grant: an id plus the capability the agent holds on it.
 *  - `Read`           → read/query immediately
 *  - `Write-approval` → propose a write, HELD in the Governance queue for a human
 *  - `Write-bounded`  → immediate write, NO approval (builder-only; server-enforced)
 * The same shape governs data products, knowledge, metrics AND connections so the
 * grant model is uniform across every artifact type. `layer` is DATA-only: which
 * medallion layer the team reads (default gold, the serving layer).
 *
 * A FOLDER grant sets `folder` and carries an empty `id` (`''`): it targets a whole
 * folder subtree rather than one artifact, resolved to the concrete item ids it
 * currently covers at run/build time (late-binding — new items under the folder are
 * picked up automatically, and the resolved set can only ever be a SUBSET of what the
 * owner may see). Item grants and folder grants share the SAME per-kind list.
 */
export type ArtifactGrant = { id: string; capability: Capability; layer?: DataLayer; folder?: FolderGrantTarget };
/** Back-compat alias — connections have always carried a capability profile. */
export type ConnectionGrant = ArtifactGrant;

/**
 * A DECLARED OUTPUT — where a team's run RESULTS are stored. The builder declares, in
 * Define, a destination artifact (a File, Dataset or Knowledge item) inside a folder
 * (existing OR new — a "new folder" is just a path that materialises when the first
 * result is written there). Declaring one AUTO-PROVISIONS a Write folder-grant on the
 * matching `grants.<kind>` (see `simple-edit.addOutput`), so the destination is
 * pre-provisioned + write-granted through the SAME grant/write-tool machinery item and
 * folder grants use — an output is NOT a parallel system, just a labelled Write target.
 * Additive + omitted from `system.yaml` when empty, so pre-outputs systems stay
 * byte-stable (mirrors the plan-grants handling).
 */
export type OutputKind = 'files' | 'data' | 'knowledge';
export type DeclaredOutput = { kind: OutputKind; name: string; folder: FolderGrantTarget };

export type Grants = {
  data: ArtifactGrant[];
  knowledge: ArtifactGrant[];
  metrics: ArtifactGrant[];
  tools: string[];
  connections: ArtifactGrant[];
  /**
   * FOLDER grants for the Files tab. Files carry NO per-item grant list (file tools
   * act over the caller's own DLS), so this list ONLY ever holds folder grants — an
   * additive channel that leaves the existing tool-only Files grant intact. Omitted
   * from `system.yaml` when empty so pre-Wave-3 files stay byte-stable.
   */
  files: ArtifactGrant[];
  /**
   * PLAN-ITEM grants — the Operating Manual (and, when generalised, Strategic Pillars
   * / Big Bets) an agent may load as context. Each `id` encodes the plan target, not a
   * free artifact id: an Operating Manual is `manual:my` · `manual:domain` · `manual:company`
   * (the scope the caller may view via `resolveManual`). Granting one provisions the
   * governed READ tool (`get_operating_manual`) — the SAME runtime path the tab uses —
   * so the agent loads it under its own DLS/scope check; nothing is pre-injected. Read-
   * only in the builder (a manual has no agent-authored write path). Additive + omitted
   * from `system.yaml` when empty, so every pre-plan-grants system stays byte-stable.
   */
  plan: ArtifactGrant[];
};

export type AgentSpec = {
  id: string;
  role: string;
  agent_md: string;
  memory_md: string;
  /** Non-empty ⇒ this agent is a supervisor routing to these member ids. */
  members?: string[];
  /** Per-agent tool narrowing; omitted ⇒ inherits the system grants. */
  tools?: string[];
  /** Optional per-agent LiteLLM `model_name`; unset ⇒ activity routing. */
  model?: string;
};

export type Edge = { from: string; to: string; type: EdgeType; when?: string };

export type Schedule = { kind: 'manual' | 'cron' | 'event'; cron?: string; event?: string };

export type System = {
  version: string;
  system: {
    name: string;
    domain: string;
    visibility: Visibility;
    /** The team's stated purpose / success criteria in the author's own words (the
     * Define description). Optional; drives the Evaluate judge's task rubric. */
    description?: string;
  };
  /** Execution engine (default `langgraph`). `hermes` = autonomous runtime. */
  runtime: Runtime;
  /** Write-back safety preset (default `read-only`, the safest). */
  safetyPreset: SafetyPreset;
  entrypoint: string;
  state: { channels: Record<string, string> };
  grants: Grants;
  routing: { overrides: Record<string, string> };
  agents: AgentSpec[];
  edges: Edge[];
  schedule?: Schedule;
  /**
   * DECLARED OUTPUTS — where this team's run results are stored (see {@link DeclaredOutput}).
   * Each entry has a matching Write folder-grant on `grants.<kind>` (added by
   * `simple-edit.addOutput`). Additive + omitted from `system.yaml` when empty so
   * pre-outputs systems stay byte-stable (mirrors `grants.plan`).
   */
  outputs?: DeclaredOutput[];
  /**
   * Presentation-only hints for the graph builder — IGNORED by the compiler and
   * the runtime. `ui.positions` stores each agent's saved x/y on the React Flow
   * canvas so a hand-arranged graph survives reload/fork. Serialized only when
   * present so existing files stay byte-stable; positions for unknown agents are
   * pruned on parse.
   */
  ui?: { positions?: Record<string, NodePosition> };
};

export type NodePosition = { x: number; y: number };

/** Validation error carrying an HTTP-friendly status so routes can surface 400s. */
export class SystemError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'SystemError';
    this.status = status;
  }
}

const VISIBILITIES: Visibility[] = ['Personal', 'Shared', 'Marketplace'];
const RUNTIMES: Runtime[] = ['langgraph', 'hermes'];
const SAFETY_PRESETS: SafetyPreset[] = ['read-only', 'read-propose', 'read-bounded', 'full-in-scope'];
const EDGE_TYPES: EdgeType[] = ['supervise', 'handoff'];
const CAPABILITIES: Capability[] = ['Off', 'Read', 'Write-approval', 'Write-bounded', 'Blocked'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strArray(v: unknown, where: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new SystemError(`system.yaml: '${where}' must be a list`);
  return v.map((x) => String(x));
}

function strMap(v: unknown): Record<string, string> {
  if (!isRecord(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) out[k] = String(val);
  return out;
}

/**
 * Parse an artifact-grant list (`data` / `knowledge` / `metrics` / `connections`),
 * migrating the OLD shape on read: a bare `string[]` of ids (or a mixed list with
 * string entries) coerces each string to `{ id, capability: 'Read' }`. This keeps
 * every system.yaml saved before per-artifact access existed working unchanged.
 *
 * `allowLayer` (DATA only) parses + validates a medallion `layer` when present;
 * `gold` (or absent) leaves the grant layer UNSET so the file stays byte-stable.
 */
function parseArtifactGrants(v: unknown, where: string, allowLayer = false): ArtifactGrant[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new SystemError(`system.yaml: '${where}' must be a list`);
  const out: ArtifactGrant[] = [];
  for (const entry of v) {
    // Back-compat: an old bare-string id ⇒ Read.
    if (typeof entry === 'string') {
      out.push({ id: entry, capability: 'Read' });
      continue;
    }
    // FOLDER grant: an entry carrying a `folder: { path, scope }` targets a whole
    // subtree (no artifact id). Resolved to concrete item ids at run/build time.
    if (isRecord(entry) && isRecord(entry.folder)) {
      const f = entry.folder;
      if (typeof f.path !== 'string') {
        throw new SystemError(`system.yaml: ${where} folder grant needs a string 'path'`);
      }
      const scope = f.scope === 'domain' ? 'domain' : 'personal';
      const capability = (entry.capability ?? 'Read') as Capability;
      if (!CAPABILITIES.includes(capability)) {
        throw new SystemError(
          `system.yaml: ${where} folder '${f.path}' has invalid capability '${String(entry.capability)}' (expected ${CAPABILITIES.join('|')})`,
        );
      }
      out.push({ id: '', capability, folder: { path: f.path, scope } });
      continue;
    }
    if (!isRecord(entry) || typeof entry.id !== 'string') {
      throw new SystemError(`system.yaml: each ${where} entry needs an 'id'`);
    }
    const capability = (entry.capability ?? 'Read') as Capability;
    if (!CAPABILITIES.includes(capability)) {
      throw new SystemError(
        `system.yaml: ${where} '${entry.id}' has invalid capability '${String(entry.capability)}' (expected ${CAPABILITIES.join('|')})`,
      );
    }
    const grant: ArtifactGrant = { id: entry.id, capability };
    if (allowLayer && entry.layer !== undefined && entry.layer !== null) {
      const layer = entry.layer as DataLayer;
      if (!DATA_LAYERS.includes(layer)) {
        throw new SystemError(
          `system.yaml: ${where} '${entry.id}' has invalid layer '${String(entry.layer)}' (expected ${DATA_LAYERS.join('|')})`,
        );
      }
      // Gold is the default/serving layer — never persist it, so files stay byte-stable.
      if (layer !== 'gold') grant.layer = layer;
    }
    out.push(grant);
  }
  return out;
}

function parseGrants(v: unknown): Grants {
  const g = isRecord(v) ? v : {};
  return {
    data: parseArtifactGrants(g.data, 'grants.data', true),
    knowledge: parseArtifactGrants(g.knowledge, 'grants.knowledge'),
    metrics: parseArtifactGrants(g.metrics, 'grants.metrics'),
    tools: strArray(g.tools, 'grants.tools'),
    connections: parseArtifactGrants(g.connections, 'grants.connections'),
    // Files hold ONLY folder grants (no per-item list) — parsed with the same
    // reader; a pre-Wave-3 file has no `grants.files` key ⇒ empty list.
    files: parseArtifactGrants(g.files, 'grants.files'),
    // Plan-item grants (Operating Manual, …) — same reader; absent ⇒ empty list.
    plan: parseArtifactGrants(g.plan, 'grants.plan'),
  };
}

/** The artifact grant lists, paired with a stable kind label for messages. Includes
 *  `files` (folder-only) so a Write-bounded folder grant is gated like any other. */
function grantKinds(sys: System): { kind: string; arr: ArtifactGrant[] }[] {
  return [
    { kind: 'data', arr: sys.grants.data },
    { kind: 'knowledge', arr: sys.grants.knowledge },
    { kind: 'metric', arr: sys.grants.metrics },
    { kind: 'connection', arr: sys.grants.connections },
    { kind: 'files', arr: sys.grants.files },
    { kind: 'plan', arr: sys.grants.plan },
  ];
}

/** A stable key for a grant — a folder grant keys on `folder:<scope>:<path>`, an item
 *  grant on its id — so folder and item direct-writes never collide on an empty id. */
function grantKey(g: ArtifactGrant): string {
  return g.folder ? `folder:${g.folder.scope}:${g.folder.path}` : g.id;
}

/** `kind:key` keys of every grant currently at `Write-bounded` (direct write). */
function directWriteKeys(sys: System): Set<string> {
  const keys = new Set<string>();
  for (const { kind, arr } of grantKinds(sys)) {
    for (const g of arr) if (g.capability === 'Write-bounded') keys.add(`${kind}:${grantKey(g)}`);
  }
  return keys;
}

/**
 * Server-side escalation guard for the SAVE boundary: `Write-bounded` (direct
 * write, no approval) may only be *introduced* by a saver who ranks builder+. A
 * creator crafting a payload with a NEW direct-write grant is REJECTED here — the
 * UI hiding the option is not trusted. Read + Write-approval are allowed at any
 * role (Write-approval still holds every effect in the Governance queue).
 *
 * Only the DELTA is enforced: when `prev` is supplied, a direct-write grant that
 * ALREADY existed (e.g. admin-set, or set before the owner was downgraded) does
 * not block an unrelated edit — a creator can always keep editing their own
 * system. Stale pre-existing direct-writes are instead neutralised at run time by
 * {@link downgradeGrantsForRole}.
 */
export function assertGrantsWithinRole(sys: System, role: Role, prev?: System): void {
  if (roleAtLeast(role, 'builder')) return;
  const already = prev ? directWriteKeys(prev) : new Set<string>();
  const offenders = [...directWriteKeys(sys)].filter((k) => !already.has(k));
  if (offenders.length > 0) {
    throw new SystemError(
      `Direct write (Write-bounded) is builder-only — the owner lacks that role for: ${offenders.join(', ')}. Use "Write (needs approval)" instead.`,
      403,
    );
  }
}

/**
 * Runtime re-assertion of the builder-gate against the OWNER's CURRENT role. When
 * the owner is no longer builder+, every `Write-bounded` (direct) artifact grant
 * is DOWNGRADED to `Write-approval` — the agent keeps working, but its writes are
 * HELD for a human in Governance rather than applied directly. Fails to approval,
 * never to error. Applied at build / run / scheduled-run so a grant set while the
 * owner was a builder cannot survive a later downgrade. Pure — returns a new
 * System, never mutates the input.
 */
export function downgradeGrantsForRole(sys: System, role: Role): System {
  if (roleAtLeast(role, 'builder')) return sys;
  const fix = (arr: ArtifactGrant[]): ArtifactGrant[] =>
    arr.map((g) => (g.capability === 'Write-bounded' ? { ...g, capability: 'Write-approval' } : g));
  return {
    ...sys,
    grants: {
      ...sys.grants,
      data: fix(sys.grants.data),
      knowledge: fix(sys.grants.knowledge),
      metrics: fix(sys.grants.metrics),
      connections: fix(sys.grants.connections),
      files: fix(sys.grants.files),
      plan: fix(sys.grants.plan),
    },
  };
}

function parseAgents(v: unknown): AgentSpec[] {
  if (!Array.isArray(v)) return [];
  return v.map((raw, i) => {
    if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.length === 0) {
      throw new SystemError(`system.yaml: agents[${i}] needs a string 'id'`);
    }
    const a: AgentSpec = {
      id: raw.id,
      role: typeof raw.role === 'string' ? raw.role : '',
      agent_md: typeof raw.agent_md === 'string' ? raw.agent_md : '',
      memory_md: typeof raw.memory_md === 'string' ? raw.memory_md : '',
    };
    if (raw.members !== undefined) a.members = strArray(raw.members, `agents.${raw.id}.members`);
    if (raw.tools !== undefined) a.tools = strArray(raw.tools, `agents.${raw.id}.tools`);
    if (raw.model !== undefined && raw.model !== null) a.model = String(raw.model);
    return a;
  });
}

function parseEdges(v: unknown): Edge[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new SystemError("system.yaml: 'edges' must be a list");
  return v.map((raw) => {
    if (!isRecord(raw) || typeof raw.from !== 'string' || typeof raw.to !== 'string') {
      throw new SystemError("system.yaml: each edge needs string 'from' and 'to'");
    }
    const type = raw.type as EdgeType;
    if (!EDGE_TYPES.includes(type)) {
      throw new SystemError(
        `system.yaml: edge '${raw.from}' -> '${raw.to}' has invalid type '${String(raw.type)}' (expected ${EDGE_TYPES.join('|')})`,
      );
    }
    const e: Edge = { from: raw.from, to: raw.to, type };
    if (typeof raw.when === 'string' && raw.when.length > 0) e.when = raw.when;
    return e;
  });
}

function parseSchedule(v: unknown): Schedule | undefined {
  if (!isRecord(v)) return undefined;
  const kind = v.kind === 'cron' || v.kind === 'event' ? v.kind : 'manual';
  const s: Schedule = { kind };
  if (kind === 'cron' && typeof v.cron === 'string') s.cron = v.cron;
  if (kind === 'event' && typeof v.event === 'string') s.event = v.event;
  return s;
}

const OUTPUT_KINDS: OutputKind[] = ['files', 'data', 'knowledge'];

/**
 * Parse the additive `outputs` list — each a {@link DeclaredOutput} with a valid kind,
 * a non-empty name and a `{ path, scope }` folder. A malformed entry (missing kind /
 * name / folder) is dropped rather than throwing, so a hand-edited file never fails to
 * open on a bad output row. Absent ⇒ empty list ⇒ omitted on serialize (byte-stable).
 */
function parseOutputs(v: unknown): DeclaredOutput[] {
  if (!Array.isArray(v)) return [];
  const out: DeclaredOutput[] = [];
  for (const raw of v) {
    if (!isRecord(raw)) continue;
    const kind = raw.kind as OutputKind;
    if (!OUTPUT_KINDS.includes(kind)) continue;
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) continue;
    if (!isRecord(raw.folder) || typeof raw.folder.path !== 'string') continue;
    const scope = raw.folder.scope === 'domain' ? 'domain' : 'personal';
    out.push({ kind, name, folder: { path: raw.folder.path, scope } });
  }
  return out;
}

/**
 * Parse the presentation-only `ui.positions` map, pruned to declared agents (a
 * position for an agent that no longer exists is dropped). Presentation data
 * NEVER affects compile/run — it only survives reload/fork.
 */
function parseUi(v: unknown, agentIds: Set<string>): System['ui'] {
  if (!isRecord(v)) return undefined;
  if (!isRecord(v.positions)) return undefined;
  const positions: Record<string, NodePosition> = {};
  for (const [id, p] of Object.entries(v.positions)) {
    if (!agentIds.has(id)) continue; // prune unknown-agent positions
    if (isRecord(p) && typeof p.x === 'number' && typeof p.y === 'number' && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      positions[id] = { x: p.x, y: p.y };
    }
  }
  return Object.keys(positions).length > 0 ? { positions } : undefined;
}

/** Parse + normalize `system.yaml` (string) or an already-decoded object. */
export function parseSystem(input: string | Record<string, unknown>): System {
  let doc: unknown;
  if (typeof input === 'string') {
    try {
      doc = yaml.load(input);
    } catch (e) {
      throw new SystemError(`system.yaml: not valid YAML — ${(e as Error).message}`);
    }
  } else {
    doc = input;
  }
  if (!isRecord(doc)) throw new SystemError('system.yaml: expected a mapping at the document root');

  const sysMeta = isRecord(doc.system) ? doc.system : {};
  const visibility = (sysMeta.visibility ?? 'Personal') as Visibility;
  if (!VISIBILITIES.includes(visibility)) {
    throw new SystemError(`system.yaml: system.visibility '${String(sysMeta.visibility)}' is invalid (expected ${VISIBILITIES.join('|')})`);
  }

  const stateRaw = isRecord(doc.state) ? doc.state : {};
  const channels = isRecord(stateRaw.channels) ? strMap(stateRaw.channels) : { messages: 'add_messages' };

  const routingRaw = isRecord(doc.routing) ? doc.routing : {};

  const runtime = (doc.runtime ?? 'langgraph') as Runtime;
  if (!RUNTIMES.includes(runtime)) {
    throw new SystemError(`system.yaml: runtime '${String(doc.runtime)}' is invalid (expected ${RUNTIMES.join('|')})`);
  }
  const safetyPreset = (doc.safety_preset ?? 'read-only') as SafetyPreset;
  if (!SAFETY_PRESETS.includes(safetyPreset)) {
    throw new SystemError(`system.yaml: safety_preset '${String(doc.safety_preset)}' is invalid (expected ${SAFETY_PRESETS.join('|')})`);
  }

  const agents = parseAgents(doc.agents);
  const ui = parseUi(doc.ui, new Set(agents.map((a) => a.id)));
  const outputs = parseOutputs(doc.outputs);

  return {
    version: doc.version !== undefined ? String(doc.version) : '1',
    system: {
      name: typeof sysMeta.name === 'string' ? sysMeta.name : 'Untitled system',
      domain: typeof sysMeta.domain === 'string' ? sysMeta.domain : '',
      visibility,
      ...(typeof sysMeta.description === 'string' && sysMeta.description.trim()
        ? { description: sysMeta.description }
        : {}),
    },
    runtime,
    safetyPreset,
    entrypoint: typeof doc.entrypoint === 'string' ? doc.entrypoint : '',
    state: { channels },
    grants: parseGrants(doc.grants),
    routing: { overrides: strMap(routingRaw.overrides) },
    agents,
    edges: parseEdges(doc.edges),
    schedule: parseSchedule(doc.schedule),
    ...(outputs.length > 0 ? { outputs } : {}),
    ...(ui ? { ui } : {}),
  };
}

/**
 * Serialize `grants` in the ORIGINAL key order (data · knowledge · metrics · tools
 * · connections), appending `files` ONLY when it holds a grant. Files' folder-grant
 * list is additive and absent on every pre-Wave-3 system, so omitting the empty key
 * keeps those `system.yaml` files byte-stable.
 */
function serializeGrants(g: Grants): Record<string, unknown> {
  const out: Record<string, unknown> = {
    data: g.data,
    knowledge: g.knowledge,
    metrics: g.metrics,
    tools: g.tools,
    connections: g.connections,
  };
  // Defensive: hand-rolled System literals may omit the additive `files` list.
  if (g.files && g.files.length > 0) out.files = g.files;
  // Additive plan-item grants — emitted only when present so pre-plan systems stay byte-stable.
  if (g.plan && g.plan.length > 0) out.plan = g.plan;
  return out;
}

/** Serialize a {@link System} back to canonical `system.yaml` text. */
export function serializeSystem(sys: System): string {
  // Drop undefined/empty-ish keys for a clean, reviewable file.
  const doc: Record<string, unknown> = {
    version: sys.version,
    system: sys.system,
    entrypoint: sys.entrypoint,
    state: sys.state,
    grants: serializeGrants(sys.grants),
  };
  // Only emit runtime/safety when they differ from the safe defaults — keeps
  // existing LangGraph systems' files byte-stable.
  if (sys.runtime && sys.runtime !== 'langgraph') doc.runtime = sys.runtime;
  if (sys.safetyPreset && sys.safetyPreset !== 'read-only') doc.safety_preset = sys.safetyPreset;
  if (Object.keys(sys.routing.overrides).length > 0) doc.routing = sys.routing;
  doc.agents = sys.agents;
  if (sys.edges.length > 0) doc.edges = sys.edges;
  if (sys.schedule) doc.schedule = sys.schedule;
  // Declared outputs — emitted ONLY when present so pre-outputs systems stay byte-stable.
  if (sys.outputs && sys.outputs.length > 0) doc.outputs = sys.outputs;
  // Presentation-only; emit ONLY when positions exist so existing files stay
  // byte-stable and the compiler/runtime never sees ui state.
  if (sys.ui?.positions && Object.keys(sys.ui.positions).length > 0) {
    doc.ui = { positions: sys.ui.positions };
  }
  return yaml.dump(doc, { lineWidth: 100, noRefs: true });
}
