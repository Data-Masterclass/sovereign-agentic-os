/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The hold decision — does a granted tool call need a human's approval before it runs?
 * USER STORY: As the engine I need to know, BEFORE executing a batch of tool calls, which of them
 *             cross a governance boundary (a Domain/Company escalation, or any write under the
 *             read-only preset) so I can park the run on an `interrupt()` and let the right admin
 *             decide — and I need that rule in a module with no `server-only` import, so the pure
 *             graph builder and its tests can call it directly.
 * ARCHITECTURE:
 *   - Pure functions over the static write-tool catalog (`@core/mcp/write-tool-meta`) and the
 *     system's `safetyPreset`. Formerly inlined in `os-tools.ts` (server-only), which now
 *     re-exports them; the rule itself is UNCHANGED (plan deviation A1-2 → lifted in A2).
 *   - `holdDecisionFor(preset, tool)` is the one entry point the engine uses: a non-write tool is
 *     never held; a write is held per {@link holdDecision}. The executor's own gate 1b applies the
 *     same rule when it runs with `holdAt: 'executor'` (its default — defence in depth for any
 *     caller that is not a graph node).
 */
import { WRITE_TOOL_NAMES } from '@core/mcp/write-tool-meta';
import type { SafetyPreset } from '@tabs/agents/lib/system-schema';

/**
 * The TARGET SCOPE of a write — the lane the artifact lands in. This is what makes
 * the hold SCOPE-AWARE: a `personal` (My) write is exactly what the runner could do
 * by hand with NO approval, so it is never held; a `domain` / `company` write is a
 * governance ESCALATION (My→Domain / Domain→Company) and IS held to the right admin.
 */
export type WriteScope = 'personal' | 'domain' | 'company';

/**
 * The ESCALATING write tools — the promotion / publish / certify / approve family
 * whose EFFECT crosses a governance boundary (My→Domain or Domain→Company). These
 * are the ONLY writes an agent (or its builder by hand) may not perform directly:
 * they are HELD to the correct admin. Everything else in the write catalog is a
 * create/author/upload/build/document/update on a PERSONAL (My) artifact — the
 * runner's own work — and is NOT held.
 *
 *   - `publish_knowledge`  — flips a workflow My→Domain (domain_admin gate).
 *   - `request_promotion`  — files a My→Domain promotion request (domain_admin).
 *   - `approve_promotion`  — APPLIES a Domain promotion (domain_admin).
 */
const ESCALATING_DOMAIN_TOOLS = new Set(['publish_knowledge', 'request_promotion', 'approve_promotion']);

/**
 * The writes whose hold is NOT a matter of the agent's rights — held to a human under EVERY
 * preset, `full-in-scope` included, by name.
 *
 *   - `delete`         — deletes an app. Not undoable by the agent, and the one platform write
 *                        whose mistake cannot be reviewed after the fact.
 *   - `archive`        — takes an app out of service for everyone it reaches.
 *   - `request_deploy` — files the go-live request and starts the review gate (scan, envelope,
 *                        diff). The twin of `request_promotion` above: asking to cross a boundary
 *                        is itself confirmed by a person.
 *
 * WHY THIS SET AND NOT `COMPANY_SCOPE_TOOLS` (the owner asked for a "company-style" hold — the
 * property wanted is "held regardless of preset", and both sets give exactly that; they differ
 * only in WHO confirms). `COMPANY_SCOPE_TOOLS` means "the effect is tenant-wide, so a PLATFORM
 * admin decides". These three act on ONE app in ONE domain, so the confirmation is routed like
 * the escalation family — to a `domain_admin` of the system's domain. Three reasons:
 *   1. the deploy `request_deploy` asks for is itself approved by a Builder; requiring a platform
 *      admin merely to let an agent ASK would invert the ladder;
 *   2. `admin` outranks `domain_admin`, so a platform admin can still confirm — nothing is lost;
 *   3. the approval card would otherwise call a personal app's deletion a "company-scope write".
 * Under `read-only` the blanket rule still wins and it goes to an admin, like every write.
 * To tighten: move a name to `COMPANY_SCOPE_TOOLS` — one line, and the posture tests say so.
 *
 * NOT self-confirmable: a parked agent run's approval is four-eyes absolute (`canApprove` in
 * `core/policy/roles.ts` refuses the requester whenever `runId` is set), so "confirmation" here
 * always means a SECOND person with the role, never the runner clicking through.
 */
const ALWAYS_CONFIRMED_TOOLS = new Set(['delete', 'archive', 'request_deploy']);

/**
 * The TENANT-WIDE writes — held to a platform `admin` under EVERY preset, because their effect is
 * not an artifact in a lane at all.
 *
 *   - `reindex_corpus` — re-parses and re-embeds every selected row of the tenant's Files or
 *     Knowledge index, through the real parser and the real embeddings gateway, spending real
 *     budget. `writeTargetScope` defaulting to `personal` would have made it the ONE thing in the
 *     write catalog that a non-read-only agent could fire at an entire tenant corpus with no
 *     human in the loop — the `commit` / `push_app_files` lesson again, one rung up: being in the
 *     write catalog makes a tool VISIBLE to the hold gate, not held by it.
 *   - `decide_deploy`, `promote` — the APPROVALS. An agent never reaches the hold for these
 *     (see below); they are listed so that if one ever does, the strictest gate answers.
 *
 * Belt and braces, deliberately: `AGENT_FORBIDDEN_TOOLS` closes all three to agent runs outright
 * (`os-tools.ts` gate 0), and this classification is the second line — so if any future door
 * reaches the hold instead, the answer is "an admin decides", never "personal, run it".
 * `core/mcp/write-tool-meta.test.ts` requires every forbidden tool to be a classified write;
 * `os-tools.test.ts` requires each to be company-scoped here.
 */
const COMPANY_SCOPE_TOOLS = new Set(['reindex_corpus', 'decide_deploy', 'promote']);

/**
 * The TARGET SCOPE of a granted write tool call. Conservative + fail-closed:
 *   - the tenant-wide family and the approvals -> Company (the admin gate);
 *   - the escalation family (promote/publish/approve) -> Domain (the My->Domain gate);
 *   - the always-confirmed family (delete/archive/request a deploy) -> Domain, same gate;
 *   - everything else (create_/ingest_/author_/upload_/build_/transform_/document_/
 *     define_/attach_/wire_/update_ ... on a My artifact) -> Personal.
 * A write only crosses a governance boundary when THIS says Domain/Company, so a
 * personal create is never held.
 *
 * `personal` is the DEFAULT, and the default has been wrong five times for a tool nobody
 * classified. A new write whose effect is destructive, tenant-wide, or an approval must be added
 * to one of the sets above when it is added to the catalog.
 */
export function writeTargetScope(mcpName: string): WriteScope {
  if (COMPANY_SCOPE_TOOLS.has(mcpName)) return 'company';
  if (ESCALATING_DOMAIN_TOOLS.has(mcpName) || ALWAYS_CONFIRMED_TOOLS.has(mcpName)) return 'domain';
  return 'personal';
}

export type HoldDecision = { held: false } | { held: true; approverRole: 'domain_admin' | 'admin' };

/**
 * SCOPE-AWARE hold: does a granted WRITE tool call cross a governance boundary that
 * must be HELD for admin approval? The scope-aware replacement for the old blanket
 * preset hold — the personal-create path is NEVER held.
 *
 *   - `read-only`                -> ALL writes blocked + queued (held to admin).
 *   - any other preset, PERSONAL -> NOT held. Falls through to the run-as-user
 *                                   governed dispatch (gate 2 = the acting user's
 *                                   OPA/DLS/role/ownership is the real authority; a
 *                                   builder has FULL rights to their own My artifact,
 *                                   so their agent does too — never more).
 *   - any other preset, DOMAIN   -> held -> routed to `domain_admin` approval.
 *   - any other preset, COMPANY  -> held -> routed to `admin` (tenant) approval.
 *
 * The security invariant: an agent NEVER exceeds what its runner could do by hand.
 */
export function holdDecision(preset: SafetyPreset, mcpName: string): HoldDecision {
  // read-only blocks every write, regardless of target.
  if (preset === 'read-only') return { held: true, approverRole: 'admin' };
  const scope = writeTargetScope(mcpName);
  if (scope === 'company') return { held: true, approverRole: 'admin' };
  if (scope === 'domain') return { held: true, approverRole: 'domain_admin' };
  // personal -> never held (the create default): gate 2 is the authority.
  return { held: false };
}

/** True for a state-modifying governed MCP tool (the static write catalog). */
export function isWriteTool(mcpName: string): boolean {
  return WRITE_TOOL_NAMES.has(mcpName);
}

/**
 * The engine's ONE question per tool call: a non-write tool is never held; a write tool is held
 * per {@link holdDecision}. Pure — the `tools_<id>` node calls it for the whole batch before
 * anything executes.
 */
export function holdDecisionFor(preset: SafetyPreset, mcpName: string): HoldDecision {
  if (!isWriteTool(mcpName)) return { held: false };
  return holdDecision(preset, mcpName);
}
