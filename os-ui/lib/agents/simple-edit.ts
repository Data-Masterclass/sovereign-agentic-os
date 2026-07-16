/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type AgentSpec, type System, type Capability, type DataLayer, type FolderGrantTarget, SystemError } from './system-schema.ts';
import { normaliseFolderPath } from '../core/folders.ts';
import { setInstructions } from './agent-md.ts';
import {
  type GrantKind,
  toolsForGrant,
  writeToolsForKind,
  capabilityWrites,
  planToolsForId,
} from './capability-tools.ts';
import { type AccessLevel, accessToCapability } from './access-levels.ts';

/**
 * Pure, immutable `system.yaml` edits for Simple mode (the guided, plain-fields
 * builder for non-coders). These produce a NEW {@link System} the caller commits
 * through the SAME `commitSystem` / file-write path Developer mode uses — so a
 * Simple edit and the equivalent Developer edit yield an IDENTICAL system.yaml.
 * There is no parallel data model; everything here is an ordinary edit to the one
 * source of truth. Deep semantics (narrow-only tools, dangling edges) stay in the
 * compiler.
 *
 * Every function `structuredClone`s its input and never mutates it, mirroring the
 * contract of `canvas-edit.ts` (Developer mode's mutators), so undo/redo snapshots
 * stay valid across a mode toggle.
 */

/** Set an agent's plain "role" (its one-line description). */
export function setAgentRole(input: System, id: string, role: string): System {
  const sys = structuredClone(input);
  const a = sys.agents.find((x) => x.id === id);
  if (!a) throw new SystemError(`Simple: '${id}' is not a declared agent`);
  a.role = role;
  return sys;
}

/**
 * Set an agent's plain "Instructions" — mapped losslessly to the AGENT.md body via
 * {@link setInstructions}, keeping any leading `# Title` heading. This writes the
 * exact same `agents[].agent_md` (projected to `agents/<id>/AGENT.md`) that
 * Developer mode's Monaco editor writes, so the round-trip is byte-identical.
 */
export function setAgentInstructions(input: System, id: string, instructions: string): System {
  const sys = structuredClone(input);
  const a = sys.agents.find((x) => x.id === id);
  if (!a) throw new SystemError(`Simple: '${id}' is not a declared agent`);
  a.agent_md = setInstructions(a.agent_md ?? '', instructions);
  return sys;
}

/**
 * Set the SYSTEM tool grants — the same `grants.tools` list Developer mode's Grants
 * panel writes (dedup, stable order preserved by insertion). Simple mode's
 * accept/toggle chips call this. Narrow-only + role floors are enforced downstream
 * by the compiler and the server SAVE guard, exactly as for the Grants panel.
 */
export function setSystemTools(input: System, tools: string[]): System {
  const sys = structuredClone(input);
  const seen = new Set<string>();
  sys.grants.tools = tools.filter((t) => (seen.has(t) ? false : (seen.add(t), true)));
  return sys;
}

/** Add a tool to the system grants (idempotent). */
export function addSystemTool(input: System, tool: string): System {
  const sys = structuredClone(input);
  if (!sys.grants.tools.includes(tool)) sys.grants.tools.push(tool);
  return sys;
}

/** Remove a tool from the system grants (and from any per-agent narrowing). */
export function removeSystemTool(input: System, tool: string): System {
  const sys = structuredClone(input);
  sys.grants.tools = sys.grants.tools.filter((t) => t !== tool);
  for (const a of sys.agents) {
    if (a.tools) {
      a.tools = a.tools.filter((t) => t !== tool);
    }
  }
  return sys;
}

/**
 * PER-AGENT tools for Simple mode. Each agent card reads "Tools THIS agent can
 * use", so add/remove must affect ONLY the clicked agent — not every sibling. The
 * fix for the bug where a tool added to one agent showed up on a different (the
 * first, inheriting) agent: an agent with no explicit `tools` INHERITS the whole
 * system pool, so any tool added to the pool appeared on it. Here we FREEZE every
 * currently-inheriting agent to its present effective set first, making each
 * agent's tool list explicit and independent, then edit only the target. The OS
 * invariant (an agent's tools ⊆ `grants.tools`) is preserved: the pool is the union.
 */
function freezeInheritedTools(sys: System): void {
  for (const a of sys.agents) if (!a.tools) a.tools = [...sys.grants.tools];
}

/** Grant a tool to ONE agent (idempotent). Other agents are unaffected. */
export function addAgentTool(input: System, agentId: string, tool: string): System {
  const sys = structuredClone(input);
  const target = sys.agents.find((a) => a.id === agentId);
  if (!target) throw new SystemError(`Simple: '${agentId}' is not a declared agent`);
  freezeInheritedTools(sys); // snapshot siblings BEFORE the pool grows
  if (!sys.grants.tools.includes(tool)) sys.grants.tools.push(tool); // keep pool ⊇ union
  target.tools = target.tools!.includes(tool) ? target.tools : [...target.tools!, tool];
  return sys;
}

/** Remove a tool from ONE agent; prune it from the pool if no agent uses it. */
export function removeAgentTool(input: System, agentId: string, tool: string): System {
  const sys = structuredClone(input);
  const target = sys.agents.find((a) => a.id === agentId);
  if (!target) throw new SystemError(`Simple: '${agentId}' is not a declared agent`);
  freezeInheritedTools(sys);
  target.tools = target.tools!.filter((t) => t !== tool);
  if (!sys.agents.some((a) => (a.tools ?? sys.grants.tools).includes(tool))) {
    sys.grants.tools = sys.grants.tools.filter((t) => t !== tool);
  }
  return sys;
}

/**
 * Simple-mode artifact grants — the plain "what your team can use" section for Data,
 * Knowledge, Files and Connections. Granting a resource AUTO-PROVISIONS the matching
 * governed MCP tools into `grants.tools` (via {@link toolsForGrant}) so the team can
 * actually USE what it's given — the label is truthful. A `write` grant additionally
 * provisions the create/write tools and, if the team is still at the `read-only`
 * default, lifts the safety preset to `read-bounded` so those writes RUN in the
 * team's own workspace (approval stays the ONE team-wide safety preset — see the
 * run-time gate `os-tools.writesAreHeld`). Data/Knowledge/Connections also record the
 * id in `grants.<kind>`; Files carry no per-artifact list (file tools act over the
 * caller's own DLS), so Files is provisioned by tools alone. Writes the SAME
 * system.yaml the Developer Grants panel does. The user can still narrow tools per
 * agent afterwards; {@link reconcileKindTools} keeps the pool in step on removal.
 */
export function setArtifactGrant(
  input: System,
  kind: GrantKind,
  id: string | null,
  write: boolean,
  layer: DataLayer = 'gold',
): System {
  return setArtifactGrantCapability(input, kind, id, write ? 'Write-bounded' : 'Read', layer);
}

/**
 * Set a per-item access LEVEL (read-only · read+propose · read+write) on a grant,
 * mapping the plain level onto the ONE grant {@link Capability} model. This is the
 * three-level entry point the "What your team can use" per-item selector uses; the
 * `read+propose` level (→ `Write-approval`) records a per-item HELD write, so it
 * needs the same create/write tools a direct write does — provisioned here.
 */
export function setArtifactGrantLevel(
  input: System,
  kind: GrantKind,
  id: string | null,
  level: AccessLevel,
  layer: DataLayer = 'gold',
): System {
  return setArtifactGrantCapability(input, kind, id, accessToCapability(level), layer);
}

/** Core: set a per-item grant to an explicit capability, provisioning matching tools. */
function setArtifactGrantCapability(
  input: System,
  kind: GrantKind,
  id: string | null,
  cap: Capability,
  layer: DataLayer = 'gold',
): System {
  const sys = structuredClone(input);
  const write = capabilityWrites(cap);
  if (kind !== 'files' && id) {
    const arr = sys.grants[kind];
    const existing = arr.find((g) => g.id === id);
    if (existing) existing.capability = cap;
    else arr.push({ id, capability: cap });
    // DATA grants alone carry a medallion layer. Gold is the serving default, so we
    // keep it UNSET (byte-stable); a non-gold layer preserves an existing pick when
    // the caller passes gold (the toggle only re-Reads a chip, never re-defaults it).
    if (kind === 'data') {
      const g = arr.find((x) => x.id === id)!;
      if (layer !== 'gold') g.layer = layer;
      else if (!existing) delete g.layer; // fresh gold grant carries no layer
      // (an existing grant keeps its stored layer when re-toggled Read/Write)
    }
  }
  // Provision the matching tools (ADD-only — never removes a hand-picked tool). Plan
  // grants are heterogeneous (manual / pillar / bet), so each grant provisions the
  // read tool for its OWN target (`planToolsForId`); every other kind uses the flat
  // per-kind map.
  const provision = kind === 'plan' && id ? planToolsForId(id, cap) : toolsForGrant(kind, cap);
  for (const t of provision) if (!sys.grants.tools.includes(t)) sys.grants.tools.push(t);
  // A Read grant of Files strips only the write tool (files have no id list, so a
  // Read after a Write must drop upload_file); the id-kinds keep write tools until
  // no grant writes (handled on removal/downgrade below).
  if (kind === 'files' && !write) for (const t of writeToolsForKind('files')) stripTool(sys, t);
  if (write && sys.safetyPreset === 'read-only') sys.safetyPreset = 'read-bounded';
  return sys;
}

/** Back-compat: a plain Read grant of a Data/Knowledge artifact (older callers). */
export function addArtifactGrant(input: System, field: 'data' | 'knowledge', id: string): System {
  return setArtifactGrant(input, field, id, false);
}

/**
 * Set the medallion LAYER a granted DATA product reads (bronze · silver · gold).
 * Gold is the curated serving default, kept UNSET so system.yaml stays byte-stable;
 * silver/bronze are recorded on the grant. A no-op when the dataset isn't granted.
 * Only DATA grants have layers — knowledge/metrics/connections don't.
 */
export function setDataGrantLayer(input: System, id: string, layer: DataLayer): System {
  const sys = structuredClone(input);
  const g = sys.grants.data.find((x) => x.id === id);
  if (!g) throw new SystemError(`Simple: '${id}' is not a granted dataset`);
  if (layer === 'gold') delete g.layer;
  else g.layer = layer;
  return sys;
}

/**
 * Persist the team's stated purpose / success criteria (the Define description). This
 * is what the Evaluate judge scores against, so capturing it in plain words makes the
 * judge grade the ACTUAL task instead of a generic fallback. Empty clears the field
 * (kept out of the serialized system.yaml so files stay byte-stable).
 */
export function setDescription(input: System, text: string): System {
  const sys = structuredClone(input);
  const trimmed = text.trim();
  if (trimmed) sys.system.description = trimmed;
  else delete sys.system.description;
  return sys;
}

/**
 * Remove a resource grant (idempotent). Read tools are LEFT in place (harmless, and
 * may be hand-picked); the kind's WRITE tools are stripped once no remaining grant of
 * the kind writes — so revoking the last write grant also revokes its create tools.
 */
export function removeArtifactGrant(input: System, kind: GrantKind, id: string | null): System {
  const sys = structuredClone(input);
  if (kind !== 'files' && id) sys.grants[kind] = sys.grants[kind].filter((g) => g.id !== id);
  // Keep the kind's WRITE tools while ANY remaining grant of the kind writes. Files carry
  // only folder grants (no item list), so count those — otherwise removing an unrelated
  // grant would wrongly strip `upload_file` while a write files-folder grant still stands.
  const stillWrites = sys.grants[kind].some((g) => capabilityWrites(g.capability));
  if (!stillWrites) for (const t of writeToolsForKind(kind)) stripTool(sys, t);
  return sys;
}

/**
 * FOLDER grant (Wave 3) — grant the whole team every item CURRENTLY under a folder,
 * late-bound at run time. A folder grant lives in the SAME per-kind list as item
 * grants (`grants.<kind>`), keyed on `{path,scope}` with an empty `id`; Files (which
 * carry no per-item list) hold their folder grants in the new `grants.files` list.
 * Granting AUTO-PROVISIONS the exact SAME `toolsForGrant(kind, cap)` an item grant
 * would (reusing the pure `capability-tools` map), so the team can actually USE what
 * the folder covers — and a `write` grant lifts a still-`read-only` team to
 * `read-bounded` so those writes RUN, exactly like {@link setArtifactGrant}. The
 * concrete item ids are resolved at run/build time, never persisted here (so newly
 * added items under the folder are picked up automatically). Idempotent — re-granting
 * the same folder updates its capability in place.
 */
export function setFolderGrant(
  input: System,
  kind: GrantKind,
  target: FolderGrantTarget,
  write: boolean,
): System {
  return setFolderGrantCapability(input, kind, target, write ? 'Write-bounded' : 'Read');
}

/** Folder-grant variant that takes a plain access LEVEL (read-only · propose · write). */
export function setFolderGrantLevel(
  input: System,
  kind: GrantKind,
  target: FolderGrantTarget,
  level: AccessLevel,
): System {
  return setFolderGrantCapability(input, kind, target, accessToCapability(level));
}

/** Core: set a folder grant to an explicit capability, provisioning matching tools. */
function setFolderGrantCapability(
  input: System,
  kind: GrantKind,
  target: FolderGrantTarget,
  cap: Capability,
): System {
  const sys = structuredClone(input);
  const write = capabilityWrites(cap);
  const path = normaliseFolderPath(target.path);
  const arr = sys.grants[kind];
  const existing = arr.find((g) => g.folder && g.folder.scope === target.scope && g.folder.path === path);
  if (existing) existing.capability = cap;
  else arr.push({ id: '', capability: cap, folder: { path, scope: target.scope } });
  // Provision the matching tools (ADD-only — never removes a hand-picked tool), the
  // SAME set an item grant of this kind+capability provisions.
  for (const t of toolsForGrant(kind, cap)) if (!sys.grants.tools.includes(t)) sys.grants.tools.push(t);
  // Files carry no per-item grant list, so a Files folder DOWNGRADE to read must strip
  // the write tool once NO remaining files grant writes — mirroring the item path
  // (`setArtifactGrantCapability`) and `removeFolderGrant`. Other kinds keep write tools
  // while any item/folder grant of the kind still writes (stripped on removal/downgrade).
  if (kind === 'files' && !write && !sys.grants.files.some((g) => capabilityWrites(g.capability))) {
    for (const t of writeToolsForKind('files')) stripTool(sys, t);
  }
  if (write && sys.safetyPreset === 'read-only') sys.safetyPreset = 'read-bounded';
  return sys;
}

/**
 * Remove a folder grant (idempotent). Read tools are LEFT in place (harmless, may be
 * hand-picked); the kind's WRITE tools are stripped once no remaining grant of the
 * kind writes — mirroring {@link removeArtifactGrant}, and counting BOTH item and
 * folder grants of the kind.
 */
export function removeFolderGrant(input: System, kind: GrantKind, target: FolderGrantTarget): System {
  const sys = structuredClone(input);
  const path = normaliseFolderPath(target.path);
  sys.grants[kind] = sys.grants[kind].filter(
    (g) => !(g.folder && g.folder.scope === target.scope && g.folder.path === path),
  );
  const stillWrites = sys.grants[kind].some((g) => capabilityWrites(g.capability));
  if (!stillWrites) for (const t of writeToolsForKind(kind)) stripTool(sys, t);
  return sys;
}

/** Remove a tool from the system pool AND from every per-agent tools override. */
function stripTool(sys: System, tool: string): void {
  sys.grants.tools = sys.grants.tools.filter((t) => t !== tool);
  for (const a of sys.agents) if (a.tools) a.tools = a.tools.filter((t) => t !== tool);
}

/**
 * Wire the team as a LINEAR handoff chain in declared order —
 * `agents[0] → agents[1] → … → agents[n]` — the auto-topology Simple mode presents.
 * Every existing `handoff` edge is REPLACED by the chain (so add/remove/reorder keep
 * it coherent); `supervise` edges and their memberships are LEFT untouched (a
 * supervisor team is a different shape the user chose). A 0- or 1-agent team gets no
 * handoff edges. Pure/immutable, like every other edit here.
 *
 * Developer mode never calls this — it edits edges freely and those edits persist.
 * Simple mode calls it after each structural change so the graph is never disconnected.
 */
export function linearizeChain(input: System): System {
  const sys = structuredClone(input);
  // Preserve any human-readable `when` label on an existing consecutive handoff so a
  // re-chain (after add/remove/reorder) keeps the scaffold's "<role> complete" hints.
  const whenOf = new Map<string, string | undefined>();
  for (const e of sys.edges) if (e.type === 'handoff') whenOf.set(`${e.from}→${e.to}`, e.when);
  // Keep supervise edges (a supervisor topology the user built); drop all handoffs.
  const kept = sys.edges.filter((e) => e.type !== 'handoff');
  const chain: typeof sys.edges = [];
  for (let i = 0; i < sys.agents.length - 1; i += 1) {
    const from = sys.agents[i].id;
    const to = sys.agents[i + 1].id;
    const when = whenOf.get(`${from}→${to}`);
    chain.push(when ? { from, to, type: 'handoff', when } : { from, to, type: 'handoff' });
  }
  sys.edges = [...kept, ...chain];
  return sys;
}

/** Next free `agentN` id (matches Developer mode's canvas guided-add naming). */
export function nextAgentId(sys: System): string {
  const ids = new Set(sys.agents.map((a) => a.id));
  let n = sys.agents.length + 1;
  let id = `agent${n}`;
  while (ids.has(id)) { n += 1; id = `agent${n}`; }
  return id;
}

/**
 * Add a fresh agent from plain fields (role + instructions). The FIRST agent
 * auto-becomes the START entrypoint so a new system compiles at once — the same
 * rule Developer mode's `addAgentGuided` applies. If no instructions are given, a
 * sensible heading+stub is used (matching the canvas `addAgent` default shape).
 */
export function addSimpleAgent(
  input: System,
  opts: { id?: string; role?: string; instructions?: string },
): System {
  const sys = structuredClone(input);
  const id = (opts.id?.trim() || nextAgentId(sys));
  if (!/^[a-z][\w-]*$/i.test(id)) {
    throw new SystemError(`Simple: '${id}' is not a valid agent id (letters, digits, - and _; must start with a letter)`);
  }
  if (sys.agents.some((a) => a.id === id)) {
    throw new SystemError(`Simple: an agent '${id}' already exists`);
  }
  const role = opts.role?.trim() || 'A helpful assistant';
  const body = opts.instructions?.trim()
    ? opts.instructions.trim()
    : `A ${role.toLowerCase()} in the Sovereign Agentic OS.\nUse only your granted, governed tools.`;
  const agent: AgentSpec = {
    id,
    role,
    agent_md: `# ${id}\n\n${body}`,
    memory_md: `# Memory\n\n(Durable facts ${id} should always know.)`,
  };
  sys.agents.push(agent);
  if (!sys.entrypoint) sys.entrypoint = id;
  // Simple mode presents a linear team — chain the new agent onto the end.
  return linearizeChain(sys);
}

/**
 * Remove ANY agent in Simple mode — including the START agent. The raw canvas
 * `removeAgent` refuses to drop the entrypoint; here, if the removed agent IS the
 * entrypoint, we first hand START to the next remaining agent (or clear it when the
 * team becomes empty), so a business user is never stuck unable to delete a card.
 * Also scrubs the agent from every supervisor `members` list + all edges.
 */
export function removeAgentSimple(input: System, agentId: string): System {
  const sys = structuredClone(input);
  if (!sys.agents.some((a) => a.id === agentId)) {
    throw new SystemError(`Simple: '${agentId}' is not a declared agent`);
  }
  if (sys.entrypoint === agentId) {
    const next = sys.agents.find((a) => a.id !== agentId);
    sys.entrypoint = next ? next.id : '';
  }
  sys.agents = sys.agents.filter((a) => a.id !== agentId);
  for (const a of sys.agents) {
    if (a.members) a.members = a.members.filter((m) => m !== agentId);
  }
  sys.edges = sys.edges.filter((e) => e.from !== agentId && e.to !== agentId);
  // Re-chain the remaining agents so the linear team stays connected (no gap where
  // the removed agent sat).
  return linearizeChain(sys);
}

/**
 * Move an agent up/down in the declared order (the guided list order). In Simple mode
 * this order IS the linear handoff chain, so reordering re-wires the chain to match
 * (via {@link linearizeChain}); the entrypoint is left as-is. Clamped — a no-op at the
 * ends (and then edges are unchanged since the order didn't move).
 */
export function moveAgent(input: System, id: string, dir: -1 | 1): System {
  const sys = structuredClone(input);
  const i = sys.agents.findIndex((a) => a.id === id);
  if (i < 0) throw new SystemError(`Simple: '${id}' is not a declared agent`);
  const j = i + dir;
  if (j < 0 || j >= sys.agents.length) return sys; // clamp: no-op at the ends
  const [a] = sys.agents.splice(i, 1);
  sys.agents.splice(j, 0, a);
  // Reordering changes the chain order — re-wire the linear handoffs to match.
  return linearizeChain(sys);
}
