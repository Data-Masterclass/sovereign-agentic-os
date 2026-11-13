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
 * The TARGET SCOPE of a granted write tool call. Conservative + fail-closed:
 *   - the escalation family (promote/publish/approve) -> Domain (the My->Domain gate);
 *   - everything else (create_/ingest_/author_/upload_/build_/transform_/document_/
 *     define_/attach_/wire_/update_/archive_ ... on a My artifact) -> Personal.
 * A write only crosses a governance boundary when THIS says Domain/Company, so a
 * personal create is never held.
 */
export function writeTargetScope(mcpName: string): WriteScope {
  if (ESCALATING_DOMAIN_TOOLS.has(mcpName)) return 'domain';
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
