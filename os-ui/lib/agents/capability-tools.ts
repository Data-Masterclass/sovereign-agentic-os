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
 */
import type { Capability, SafetyPreset } from './system-schema.ts';

/** The four resource kinds the Simple builder grants. `files` has no per-artifact
 * grant list (file tools act over the caller's own DLS), so it is provisioned by
 * tools alone; the other three also carry a `grants.<kind>` id list. */
export type GrantKind = 'data' | 'knowledge' | 'files' | 'connections';

/** Read + discovery tools per kind — always provisioned for any usable grant. */
const READ_TOOLS: Record<GrantKind, string[]> = {
  data: ['query_data', 'list_datasets', 'get_dataset', 'profile_dataset'],
  knowledge: ['search_knowledge', 'list_knowledge', 'get_knowledge'],
  files: ['list_files', 'search_files', 'get_file'],
  connections: ['list_connections', 'get_connection', 'test_connection', 'list_connection_templates'],
};

/** Create/write tools per kind — added on top of the read set when the grant writes.
 * Promotion/lifecycle tools (request_promotion, publish_knowledge, promote_connection,
 * approve_*) are DELIBERATELY excluded: those are governed hand-offs, not "use it". */
const WRITE_TOOLS: Record<GrantKind, string[]> = {
  data: ['create_dataset', 'ingest_dataset', 'transform_silver', 'build_gold_join', 'add_dataset_version', 'document_dataset'],
  knowledge: ['author_knowledge', 'index_knowledge'],
  files: ['upload_file'],
  connections: ['create_connection'],
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
