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
import type { Capability, Grants, SafetyPreset, ArtifactGrant } from './system-schema.ts';
import { planTargetOf } from './plan-grants.ts';

/** The resource kinds the Simple builder grants. `files` has no per-artifact
 * grant list (file tools act over the caller's own DLS), so it is provisioned by
 * tools alone; the others also carry a `grants.<kind>` id list. `metrics` and `plan`
 * are read-only (no agent author path), so they provision read tools only. `plan`
 * holds heterogeneous Plan grants — Operating Manual (`manual:*`), Strategic Pillar
 * (`pillar:*`) and Big Bet (`bigbet:*`) — each of which provisions its OWN governed
 * read tool (see {@link planToolsForId}); the store DLS/scope-checks the request. */
export type GrantKind = 'data' | 'knowledge' | 'files' | 'connections' | 'metrics' | 'plan';

/** Read + discovery tools per kind — always provisioned for any usable grant. */
const READ_TOOLS: Record<GrantKind, string[]> = {
  data: ['query_data', 'list_datasets', 'get_dataset', 'profile_dataset'],
  knowledge: ['search_knowledge', 'list_knowledge', 'get_knowledge'],
  files: ['list_files', 'search_files', 'get_file'],
  connections: ['list_connections', 'get_connection', 'test_connection', 'list_connection_templates', 'warehouse_registration'],
  metrics: ['list_metrics', 'query_metric', 'get_metric'],
  plan: ['get_operating_manual'],
};

/**
 * The ALWAYS-available core connection read tools — a strict subset of
 * `READ_TOOLS.connections` that excludes `warehouse_registration`, which is only
 * registered when `config.externalConnectorsEnabled` is on. The capability CHIP gates
 * on this core set so a granted connection ALWAYS surfaces its chip (the catalog check
 * would otherwise hide the whole chip whenever external connectors are off). Grant
 * PROVISIONING still uses the full `READ_TOOLS.connections`, so the warehouse tool is
 * added to `grants.tools` and becomes usable the moment the connector config is on
 * (the runtime just drops it when unregistered — harmless).
 */
const CONNECTIONS_CHIP_TOOLS = ['list_connections', 'get_connection', 'test_connection', 'list_connection_templates'];

/** Create/write tools per kind — added on top of the read set when the grant writes.
 * Promotion/lifecycle tools (request_promotion, publish_knowledge, promote_connection,
 * approve_*) are DELIBERATELY excluded: those are governed hand-offs, not "use it".
 * Metrics + plan have no author path in the builder, so writing grants nothing extra. */
const WRITE_TOOLS: Record<GrantKind, string[]> = {
  data: ['create_dataset', 'ingest_dataset', 'transform_silver', 'build_gold_join', 'add_dataset_version', 'document_dataset'],
  knowledge: ['author_knowledge', 'index_knowledge'],
  files: ['upload_file'],
  connections: ['create_connection', 'import_warehouse_table'],
  metrics: [],
  plan: [],
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

/**
 * The governed READ tools a single `grants.plan` grant provisions, chosen by which
 * plan target its id encodes. A manual grant provisions the manual read tool; a pillar
 * grant provisions `get_pillar` (+ `list_pillars` for discovery); a bet grant provisions
 * `get_big_bet` (+ `list_big_bets`). Each tool DLS/scope-checks the request inside its
 * store at run time — read-only, never widening beyond what the caller may view. An
 * unrecognised id provisions nothing (fail-closed). Plan grants are always read-only,
 * so `capability` only gates Off/Blocked (which grant nothing).
 */
const PLAN_TOOLS_BY_TARGET: Record<'manual' | 'pillar' | 'bigbet', string[]> = {
  manual: ['get_operating_manual'],
  pillar: ['get_pillar', 'list_pillars'],
  bigbet: ['get_big_bet', 'list_big_bets'],
};

export function planToolsForId(id: string, capability: Capability): string[] {
  if (capability === 'Off' || capability === 'Blocked') return [];
  const target = planTargetOf(id);
  return target ? [...PLAN_TOOLS_BY_TARGET[target]] : [];
}

/** Every tool a plan grant could ever provision across all plan targets. */
export function allPlanTools(): string[] {
  return Array.from(new Set(Object.values(PLAN_TOOLS_BY_TARGET).flat()));
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
export type ChipGrantKind = 'data' | 'knowledge' | 'files' | 'connections' | 'metrics' | 'plan' | null;

/** The grant lists a chip's surfacing predicate may inspect (every grantable kind). */
type ChipGrants = Pick<Grants, 'data' | 'knowledge' | 'files' | 'connections' | 'metrics' | 'plan'>;

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
    tools: CONNECTIONS_CHIP_TOOLS,
  },
  {
    id: 'create-files',
    label: 'Use files',
    description: "Read and search the files in the folders the team was given access to.",
    domain: 'Files',
    grantKind: 'files',
    tools: READ_TOOLS.files,
  },
  {
    id: 'query-metrics',
    label: 'Query metrics',
    description: 'Read the metrics and KPIs the team tracks.',
    domain: 'Metrics',
    grantKind: 'metrics',
    tools: READ_TOOLS.metrics,
  },
  {
    id: 'use-goals',
    label: 'Use goals',
    description: "Read the team's strategic pillars and big bets that were granted.",
    domain: 'Goals',
    grantKind: 'plan',
    // The pillar + big-bet governed read tools (the two GOAL plan targets) — kept in
    // step with what `planToolsForId` provisions for a pillar/bet grant so the chip
    // round-trips against a granted goal.
    tools: [...PLAN_TOOLS_BY_TARGET.pillar, ...PLAN_TOOLS_BY_TARGET.bigbet],
  },
  {
    id: 'read-operating-manual',
    label: 'Read operating manual',
    description: "Load the granted Operating Manual (how the team/company operates) as context.",
    domain: 'Plan',
    grantKind: 'plan',
    tools: READ_TOOLS.plan,
  },
];

/**
 * The chips a specific agent SHOULD be offered, given the team's grants and the
 * caller's role-floor catalog. Rules:
 *
 * 1. A chip whose `grantKind` is non-null is only offered when `grants[grantKind]`
 *    has at least one entry (i.e. the team was actually granted that resource). The
 *    `plan` grant is heterogeneous — an Operating-Model grant (`manual:*`) surfaces the
 *    operating-manual chip, while a Strategic-Pillar/Big-Bet grant (`pillar:*`/`bigbet:*`)
 *    surfaces the goals chip — so plan chips gate on the plan-grant TARGETS, not merely
 *    on a non-empty list (see {@link planChipMatches}).
 * 2. Every tool in a chip's `tools` list must appear in `catalog` (the role-scoped
 *    list from the platform) — if any tool is absent the chip is not offered.
 *    When `catalog` is `null` (still loading) no filtering by catalog is applied.
 *
 * Returns a subset of `CAPABILITY_CHIPS` in the same order.
 */
export function capabilityChipsForGrants(
  grants: ChipGrants,
  catalog: string[] | null,
): CapabilityChip[] {
  return CAPABILITY_CHIPS.filter((chip) => {
    // Must have the resource grant when grantKind is non-null.
    if (chip.grantKind !== null) {
      const list = grants[chip.grantKind];
      if (!Array.isArray(list) || list.length === 0) return false;
      // Plan grants are heterogeneous — surface by the specific plan target.
      if (chip.grantKind === 'plan' && !planChipMatches(chip.id, list)) return false;
    }
    // All tools must be in the catalog (when catalog has loaded).
    if (catalog !== null && chip.tools.some((t) => !catalog.includes(t))) return false;
    return true;
  });
}

/**
 * Whether a plan-gated chip is warranted by the plan grants held. The goals chip
 * (`use-goals`) needs a `pillar:`/`bigbet:` grant; the operating-manual chip
 * (`read-operating-manual`) needs a `manual:` grant. Keeps the two plan chips from
 * both firing off one another's grant.
 */
function planChipMatches(chipId: string, planGrants: ArtifactGrant[]): boolean {
  const targets = new Set(planGrants.map((g) => planTargetOf(g.id)));
  if (chipId === 'use-goals') return targets.has('pillar') || targets.has('bigbet');
  if (chipId === 'read-operating-manual') return targets.has('manual');
  return true;
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
 * Every tool a selected chip COULD map to (read ∪ write for its kind), regardless of
 * what the team granted. A resource chip (`grantKind` data/knowledge/files/…) spans
 * that kind's full read+write set; the two plan chips span their governed plan read
 * tools (plan grants are read-only). This is the candidate set — the caller intersects
 * it with the team pool to get the actual per-agent tools (see
 * {@link toolsForCapabilityChipsInPool}).
 */
function candidateToolsForChip(chip: CapabilityChip): string[] {
  if (chip.grantKind !== null && chip.grantKind !== 'plan') {
    // A resource kind: the agent gets the kind at WHATEVER access the team granted it,
    // so offer read ∪ write and let the pool intersection decide.
    return allToolsForKind(chip.grantKind);
  }
  // Plan (and any always-on) chip: plan grants are read-only, so its static read tools
  // ARE its full candidate set.
  return chip.tools;
}

/**
 * The per-agent tools a set of selected capability chips resolves to, GIVEN the team
 * pool (`system.grants.tools`). For each selected chip we take every tool its kind
 * could ever provision (read ∪ write) and INTERSECT it with the pool — so a chip means
 * "this kind, at whatever access the team was actually granted" (read + any granted
 * write), never more. The `∩ pool` is the security invariant: the result is always a
 * subset of the team grant, so a per-agent capability can never widen beyond it. This
 * is what {@link toolsForCapabilityChips} could not do — that only knew a chip's static
 * READ tools and so dropped every granted write tool.
 */
export function toolsForCapabilityChipsInPool(chipIds: string[], pool: string[]): string[] {
  const chipMap = new Map(CAPABILITY_CHIPS.map((c) => [c.id, c]));
  const poolSet = new Set(pool);
  const out = new Set<string>();
  for (const id of chipIds) {
    const chip = chipMap.get(id);
    if (!chip) continue;
    for (const t of candidateToolsForChip(chip)) if (poolSet.has(t)) out.add(t);
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
