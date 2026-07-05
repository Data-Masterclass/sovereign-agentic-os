/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { McpTab } from './server';
import { loadTabContext, tabTitle } from '@/lib/tabs/context';

/**
 * The MCP `initialize.instructions` composer — the ONE channel that reaches the
 * model's context BEFORE any tool call. The overarching `/api/mcp` serves the
 * full orientation; a per-tab `/api/mcp/<tab>` serves that tab's brief + the
 * SAME governance core. Kept tight on purpose (it lands in every session).
 */

/** The ~90-word governance core appended to every per-tab brief (single source). */
const GOVERNANCE_CORE = `GOVERNANCE (same for every surface): everything runs AS the signed-in user — OPA-policy-checked, row/document-level-security filtered, Langfuse audit-traced. This MCP is the SAME governed path as the UI, never a bypass.
ROLES: creator — creates/builds/runs their OWN work + consumes shared assets + FILES promotion requests; CANNOT promote/publish/approve. builder — + approve Personal→Shared in-domain, approve deploys. admin — + certify to the marketplace, cross-domain bets, policy overrides.
FIRST: call whoami then list_capabilities. DISCOVER before you create: read the caller's sovereign-os://my/* inventory (or the matching list_* tool) and reuse ids. Tool errors are typed {code, reason, hint} — follow the hint.`;

/** The full orientation for the overarching endpoint (~340 words). */
const OVERVIEW = `You are connected to the SOVEREIGN AGENTIC OS — one governed operating system for data, knowledge, connections, files, metrics, dashboards, software, agents, science and big bets. Everything you do here runs AS the signed-in user, is OPA-policy-checked, row/document-level-security filtered, and audit-traced. This MCP is a front door, not a back door: it is the SAME governed path as the UI.

FIRST, ALWAYS: call \`whoami\` (your identity, role, domains, and what you can/cannot do), then \`list_capabilities\` (every tool, split into available vs gated). Then read \`sovereign-os://guide/overview\` and, before building anything, \`sovereign-os://guide/path/<pathway>\` for the exact tool sequence (or call \`get_guide\`).

ROLES (the caller's role decides everything):
- creator — creates and runs their OWN work in their own domain(s) and consumes shared assets. CANNOT promote/publish/approve/certify. When a golden path reaches a promote step, a creator FILES a request (\`request_promotion\`) and hands off to a Builder.
- builder — creator rights + approve Personal→Shared in their domain (\`approve_promotion\`, \`publish_knowledge\`, \`decide_deploy\`, \`promote_connection\`), manage domain members.
- admin — builder rights tenant-wide + certify to the marketplace, cross-domain big bets, policy overrides and cost caps.
Tier ladder: Personal → Shared (Builder gate) → Certified (Admin gate). Promotion ALWAYS requires documentation first.

BUILD ON WHAT EXISTS: before creating a dataset, workflow, connection, metric or agent, DISCOVER what the user already has — read \`sovereign-os://my/<datasets|knowledge|connections|files|metrics|dashboards|agents|software|bigbets|science>\` or call the matching \`list_*\` tool. Reuse and reference existing ids.

RULES: use ONLY these OS tools for OS artifacts — never fabricate ids, never invent a bypass. Tool errors are typed \`{code, reason, hint}\` — follow the hint (e.g. \`forbidden\` → ask a Builder or keep the work Personal). Read-only SQL only in \`query_data\`. Prompts (slash commands) exist for every golden path — prefer them when starting a new build.`;

/**
 * Build the `initialize.instructions` for an endpoint. No `tab` → the full
 * overarching orientation. A `tab` → that tab's CONTEXT.md brief + the shared
 * governance core (so a per-tab lens still carries the whole rule set).
 */
export function buildInstructions(tab?: McpTab): string {
  if (!tab) return OVERVIEW;
  const brief = loadTabContext(tab).trim();
  const header = brief ? brief : `# ${tabTitle(tab)} — Sovereign Agentic OS MCP (per-tab lens)`;
  return `${header}\n\n${GOVERNANCE_CORE}`;
}
