/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { McpTab } from '@core/mcp/server';
import { loadTabContext, tabTitle } from '@core/tabs-meta/context';
import { TAB_GROUPS, TAB_FEATURES, type TabGroup } from '@core/kernel/tabs';
import { ACCOUNT_ITEMS } from '@core/ui/account-menu';

/**
 * The MCP `initialize.instructions` composer — the ONE channel that reaches the
 * model's context BEFORE any tool call. The overarching `/api/mcp` serves the
 * full orientation; a per-tab `/api/mcp/<tab>` serves that tab's brief + the
 * SAME governance core. Kept tight on purpose (it lands in every session).
 */

/** The ~90-word governance core appended to every per-tab brief (single source). */
const GOVERNANCE_CORE = `GOVERNANCE (same for every surface): everything runs AS the signed-in user — OPA-policy-checked, row/document-level-security filtered, Langfuse audit-traced. This MCP is the SAME governed path as the UI, never a bypass.
MY IS YOURS: in your own My (personal) scope you have FULL rights with NO approval — you (and the agents you build, which run AS you) create/write your own data, files, knowledge, metrics, connections, dashboards, agents and software directly. Approval only enters when you push UP a scope: Domain needs a domain admin, Company needs an admin (via Policies & Approvals). You can only change what YOU built. The agent write-gate is scope-aware: a My write runs directly; a Domain/Company write is held for the right admin.
ROLES (4): creator — creates/builds/runs their OWN work + consumes Domain/Company assets + FILES promotion requests; CANNOT promote/publish/approve. builder — + approve software deploys; files promotion requests like anyone. domain_admin — + approve every My→Domain promotion in their domain(s). admin — + certify to Company, policy overrides, cost caps and all user administration (Platform → Users & Access).
FIRST: call whoami then list_capabilities. DISCOVER before you create: read the caller's sovereign-os://my/* inventory (or the matching list_* tool) and reuse ids. Tool errors are typed {code, reason, hint} — follow the hint.`;

/**
 * The NAV sentence, rendered from the sidebar's own tables (`TAB_GROUPS`, filtered by this
 * install's enabled tabs, plus the account menu) so it can only name places that exist.
 * It used to be hand-written and named eight tabs that had been removed.
 */
export function navSentence(groups: TabGroup[] = TAB_GROUPS, enabled: ReadonlySet<string> = TAB_FEATURES): string {
  const parts = groups
    .map((g) => ({ heading: g.heading ?? 'Entry', labels: g.tabs.filter((t) => !t.feature || enabled.has(t.feature)).map((t) => t.label) }))
    .filter((g) => g.labels.length > 0)
    .map((g) => `${g.heading} (${g.labels.join(' · ')})`);
  const account = ACCOUNT_ITEMS.map((i) => i.label).join(' · ');
  return `NAV (so you can orient the user): ${parts.join(' · ')}. Your account menu (under your name in the sidebar) holds ${account}. There is no separate personal (DuckDB) query engine — one governed Trino/Iceberg engine for everything.`;
}
const NAV = navSentence();

/** The full orientation for the overarching endpoint (~340 words). */
const OVERVIEW = `You are connected to the SOVEREIGN AGENTIC OS — one governed operating system for data, knowledge, connections, files, metrics, dashboards, software and agents. Everything you do here runs AS the signed-in user, is OPA-policy-checked, row/document-level-security filtered, and audit-traced. This MCP is a front door, not a back door: it is the SAME governed path as the UI.

FIRST, ALWAYS: call \`whoami\` (your identity, role, domains, and what you can/cannot do), then \`list_capabilities\` (every tool, split into available vs gated). For a "how do I use this MCP" orientation read \`sovereign-os://guide/how-to-use\` or call \`get_guide()\` with no argument. Then read \`sovereign-os://guide/overview\` and, before building anything, \`sovereign-os://guide/path/<pathway>\` for the exact tool sequence (or call \`get_guide('<pathway>')\`).

ROLES (4, lowest→highest — the caller's role decides everything):
- creator — creates and runs their OWN work in their own domain(s) with FULL rights and NO approval, and consumes Domain/Company assets. CANNOT promote/publish/approve/certify. When a golden path reaches a promote step, a creator FILES a request (\`request_promotion\`) and hands off.
- builder — creator rights + approve software deploys (\`decide_deploy\`). An approver of their own filed work is NOT its promotion approver. Files promotion requests like anyone; the artifact My→Domain APPROVAL itself is domain_admin.
- domain_admin — builder rights + APPROVE every My→Domain artifact promotion in their domain (\`approve_promotion\`, \`publish_knowledge\`, \`promote_connection\`). No tenant/platform powers, and no user administration.
- admin — everything tenant-wide + certify to Company, policy overrides, cost caps and ALL user administration (invite, edit, deactivate, assign roles, appoint domain admins).
Scope ladder: My → Domain (domain-admin gate: "Promote to Domain") → Company (Admin gate: "Promote to Company"/certify). Promotion ALWAYS requires documentation first. In My scope there is NO approval — full rights over your own work; only promoting UP a scope is gated.

${NAV}

BUILD ON WHAT EXISTS: before creating a dataset, workflow, connection, metric or agent, DISCOVER what the user already has — read \`sovereign-os://my/<datasets|knowledge|connections|files|metrics|dashboards|agents|software>\` or call the matching \`list_*\` tool. Reuse and reference existing ids.

RULES: use ONLY these OS tools for OS artifacts — never fabricate ids, never invent a bypass. Tool errors are typed \`{code, reason, hint}\` — follow the hint (e.g. \`forbidden\` → ask a domain admin, or keep the work in My scope). Read-only SQL only in \`query_data\`. Prompts (slash commands) exist for every golden path — prefer them when starting a new build.`;

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
