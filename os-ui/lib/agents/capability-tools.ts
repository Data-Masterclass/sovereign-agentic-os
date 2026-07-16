/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Capability → MCP-tool provisioning for the Simple builder's "What your team can
 * use" grants. Granting a resource at an access level should make it USABLE — so we
 * auto-provision the matching governed tools into `grants.tools` (the user can still
 * narrow them per agent afterwards). This is the pure mapping; `simple-edit.ts`
 * unions/prunes the result and keeps the team safety preset in step.
 *
 * PURE (no server-only, no secrets): imported by both the client SimpleBuilder and
 * the server grant helpers, so the same READ/WRITE tool sets are used everywhere.
 *
 * Access levels mirror `ArtifactGrant.capability`:
 *   - `Read`           → read + discovery tools only.
 *   - `Write-approval` → read tools + create/write tools (held for approval by the
 *                        team safety preset at run-time — see os-tools `writesAreHeld`).
 *   - `Write-bounded`  → read tools + create/write tools, run directly (no hold).
 * `Off` / `Blocked` grant no tools.
 *
 * ### Per-agent capability chips (Simple builder Design phase)
 *
 * Instead of showing a raw tool list, the Simple builder offers plain capability
 * chips — each maps to the underlying tool set the team was actually granted.
 * `CAPABILITY_CHIPS` is the ordered list; `capabilityChipsForGrants` filters it to
 * what the team's grants allow; `toolsForCapabilityChips` builds the tool list to
 * persist; `chipIdsForTools` reads an existing agent.tools list back into chips.
 *
 * When `agent.tools` is `undefined` (inherits the system grant pool) that is the
 * **Auto** default — the agent gets whatever the team was granted. Only when the
 * author explicitly narrows (picks chips) does `agent.tools` get set.
 */
import type { Capability, Grants, SafetyPreset } from './system-schema.ts';

/** The four resource kinds the Simple builder grants. `files` has no per-artifact
 * grant list (file tools act over the caller's own DLS), so it is provisioned by
 * tools alone; the other three also carry a `grants.<kind>` id list. */
export type GrantKind = 'data' | 'knowledge' | 'files' | 'connections';

/** Read + discovery tools per kind — always provisioned for any usable grant. */
const READ_TOOLS: Record<GrantKind, string[]> = {
  data: ['query_data', 'list_datasets', 'get_dataset', 'profile_dataset'],
  knowledge: ['search_knowledge', 'list_knowledge', 'get_knowledge'],
  files: ['list_files', 'search_files', 'get_file'],
  connections: ['list_connections', 'get_connection', 'test_connection', 'list_connection_templates', 'warehouse_registration'],
};

/** Create/write tools per kind — added on top of the read set when the grant writes.
 * Promotion/lifecycle tools (request_promotion, publish_knowledge, promote_connection,
 * approve_*) are DELIBERATELY excluded: those are governed hand-offs, not "use it". */
const WRITE_TOOLS: Record<GrantKind, string[]> = {
  data: ['create_dataset', 'ingest_dataset', 'transform_silver', 'build_gold_join', 'add_dataset_version', 'document_dataset'],
  knowledge: ['author_knowledge', 'index_knowledge'],
  files: ['upload_file'],
  connections: ['create_connection', 'import_warehouse_table'],
};

/** True when the capability lets the team WRITE (not just read). */
export function capabilityWrites(cap: Capability): boolean {
  return cap === 'Write-approval' || cap === 'Write-bounded';
}

/**
 * The MCP tools a grant of `kind` at `capability` should provision. Read grants get
 * the read+discovery set; write grants also get the create/write set. Off/Blocked
 * grant nothing. Order-preserved, deduped.
 */
export function toolsForGrant(kind: GrantKind, capability: Capability): string[] {
  if (capability === 'Off' || capability === 'Blocked') return [];
  const out = [...READ_TOOLS[kind]];
  if (capabilityWrites(capability)) out.push(...WRITE_TOOLS[kind]);
  return Array.from(new Set(out));
}

/** Every tool this module could ever provision for `kind` (read ∪ write). */
export function allToolsForKind(kind: GrantKind): string[] {
  return Array.from(new Set([...READ_TOOLS[kind], ...WRITE_TOOLS[kind]]));
}

/** Just the create/write tools for `kind` — stripped when a kind stops writing.
 * Read tools are left in place on removal (harmless, and may be hand-picked). */
export function writeToolsForKind(kind: GrantKind): string[] {
  return [...WRITE_TOOLS[kind]];
}

// ─── Per-agent capability chips ──────────────────────────────────────────────

/**
 * The grant kind (from `Grants`) that must have at least one entry before a chip
 * is offered. `null` means the chip is always available (ungated by a resource
 * grant — it just needs to be in the catalog).
 */
export type ChipGrantKind = 'data' | 'knowledge' | 'connections' | 'metrics' | null;

export type CapabilityChip = {
  /** Stable id persisted nowhere — used only in UI state and tests. */
  id: string;
  label: string;
  description: string;
  /** The tab/domain this capability belongs to — used to GROUP the picker window. */
  domain: string;
  /**
   * Which `Grants` key must be non-empty for this chip to appear. `null` = always
   * shown (the tool just needs to exist in the catalog).
   */
  grantKind: ChipGrantKind;
  /** The MCP tools this chip provisions on the agent (read set only — agents read). */
  tools: string[];
};

/** Ordered list of all possible per-agent capability chips. */
export const CAPABILITY_CHIPS: CapabilityChip[] = [
  {
    id: 'read-data',
    label: 'Read data',
    description: 'Query and explore the datasets the team was given access to.',
    domain: 'Data',
    grantKind: 'data',
    tools: READ_TOOLS.data,
  },
  {
    id: 'search-knowledge',
    label: 'Search knowledge',
    description: 'Search and read the knowledge workflows and documents the team can use.',
    domain: 'Knowledge',
    grantKind: 'knowledge',
    tools: READ_TOOLS.knowledge,
  },
  {
    id: 'use-connection',
    label: 'Use a connection',
    description: 'Call the external connections (APIs, databases) the team was given.',
    domain: 'Connections',
    grantKind: 'connections',
    tools: READ_TOOLS.connections,
  },
  {
    id: 'create-files',
    label: 'Create/edit files',
    description: "Read, write and search files in the team's file space.",
    domain: 'Files',
    grantKind: null,
    tools: [...READ_TOOLS.files, ...WRITE_TOOLS.files],
  },
  {
    id: 'query-metrics',
    label: 'Query metrics',
    description: 'Read the metrics and KPIs the team tracks.',
    domain: 'Metrics',
    grantKind: 'metrics',
    tools: ['list_metrics', 'query_metric', 'get_metric'],
  },
  {
    id: 'use-goals',
    label: 'Use goals',
    description: "Read the team's big bets and strategic goals.",
    domain: 'Goals',
    grantKind: null,
    tools: ['list_big_bets', 'get_big_bet'],
  },
];

/**
 * The chips a specific agent SHOULD be offered, given the team's grants and the
 * caller's role-floor catalog. Rules:
 *
 * 1. A chip whose `grantKind` is non-null is only offered when `grants[grantKind]`
 *    has at least one entry (i.e. the team was actually granted that resource).
 * 2. Every tool in a chip's `tools` list must appear in `catalog` (the role-scoped
 *    list from the platform) — if any tool is absent the chip is not offered.
 *    When `catalog` is `null` (still loading) no filtering by catalog is applied.
 *
 * Returns a subset of `CAPABILITY_CHIPS` in the same order.
 */
export function capabilityChipsForGrants(
  grants: Pick<Grants, 'data' | 'knowledge' | 'connections' | 'metrics'>,
  catalog: string[] | null,
): CapabilityChip[] {
  return CAPABILITY_CHIPS.filter((chip) => {
    // Must have the resource grant when grantKind is non-null.
    if (chip.grantKind !== null) {
      const list = grants[chip.grantKind as keyof Pick<Grants, 'data' | 'knowledge' | 'connections' | 'metrics'>];
      if (!Array.isArray(list) || list.length === 0) return false;
    }
    // All tools must be in the catalog (when catalog has loaded).
    if (catalog !== null && chip.tools.some((t) => !catalog.includes(t))) return false;
    return true;
  });
}

/** The union of all tools for a set of chip ids. */
export function toolsForCapabilityChips(chipIds: string[]): string[] {
  const chipMap = new Map(CAPABILITY_CHIPS.map((c) => [c.id, c]));
  const out = new Set<string>();
  for (const id of chipIds) {
    const chip = chipMap.get(id);
    if (chip) for (const t of chip.tools) out.add(t);
  }
  return Array.from(out);
}

/**
 * Best-effort reverse mapping: given an agent's explicit `tools` list, return the
 * chip ids that are fully covered. Used to read an existing narrowed agent back into
 * the chip UI without losing the user's previous selection.
 */
export function chipIdsForTools(tools: string[]): string[] {
  const toolSet = new Set(tools);
  return CAPABILITY_CHIPS.filter((c) => c.tools.every((t) => toolSet.has(t))).map((c) => c.id);
}

// ─── Team-level grant ↔ tool provisioning ────────────────────────────────────

/** The safety preset a single grant's capability implies (its contribution to the
 * team-wide posture). Read contributes the floor; write-approval holds; write-bounded
 * runs directly (full-in-scope). */
export function presetForCapability(cap: Capability): SafetyPreset {
  if (cap === 'Write-bounded') return 'full-in-scope';
  if (cap === 'Write-approval') return 'read-propose';
  return 'read-only';
}

const PRESET_RANK: Record<SafetyPreset, number> = {
  'read-only': 0,
  'read-propose': 1,
  'read-bounded': 2,
  'full-in-scope': 3,
};

/** The strongest (most permissive) preset in a list; `read-only` for an empty list.
 * Approval is one team-wide knob, so the whole team runs at the strongest grant's
 * posture — a single "write-direct" grant makes the team full-in-scope. */
export function strongestPreset(presets: SafetyPreset[]): SafetyPreset {
  let best: SafetyPreset = 'read-only';
  for (const p of presets) if (PRESET_RANK[p] > PRESET_RANK[best]) best = p;
  return best;
}
