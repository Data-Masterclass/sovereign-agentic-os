/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       mcp
 * FEATURE:    Product claims pinned to the code — what the MCP door TELLS an assistant
 * USER STORY: As an assistant connected by MCP I want every tool, resource, tab, Platform
 *             section and role statement I am told about to exist and to match the gate
 *             that enforces it, so I never send the user to a place that is not there or
 *             tell them they may do something the OS will refuse.
 * ARCHITECTURE:
 *   - One corpus: every text an assistant reads before or while calling a tool — the
 *     `initialize` instructions (overall + per tab), every guide and tab brief, every
 *     rendered prompt (for each role), every tool description and input schema, every
 *     resource description, and the typed error hints.
 *   - Each test reads that corpus and checks one kind of claim against the code table that
 *     makes it true: the tool registry, the resource list, `TAB_GROUPS` + the account menu,
 *     the Platform section table, each tool's `minRole`, and `canPromote`.
 *   - Imports `@core/*` only. The Platform section labels are read from the tab's source
 *     file as text, so this core test does not import a tab.
 *   - The existing backtick tripwire in `tabs.test.ts` stays; this widens it to bare names
 *     and to every text, not only markdown.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CurrentUser } from '@core/kernel/auth';
import type { Role } from '@core/kernel/session';

globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { ALL_MCP_TOOLS, MCP_TABS, handleRpc, structuredError } = await import('./server.ts');
const { PROMPTS, renderPrompt } = await import('./prompts.ts');
const { RESOURCES, RESOURCE_TEMPLATES } = await import('./resources.ts');
const { buildInstructions } = await import('./instructions.ts');
const { GUIDE_PATHS, loadGuide } = await import('@core/tabs-meta/guides');
const { loadTabContext } = await import('@core/tabs-meta/context');
const { TAB_GROUPS } = await import('@core/kernel/tabs');
const { ACCOUNT_ITEMS } = await import('@core/ui/account-menu');
const { canPromote, ROLES } = await import('@core/kernel/session');

const user = (role: Role): CurrentUser => ({ id: `u_${role}`, name: role, role, domains: ['sales'] });

/** Every text an assistant is shown, labelled by where it comes from. */
function corpus(): { src: string; text: string }[] {
  const out: { src: string; text: string }[] = [{ src: 'instructions', text: buildInstructions() }];
  for (const tab of MCP_TABS) {
    out.push({ src: `instructions:${tab}`, text: buildInstructions(tab) });
    out.push({ src: `context:${tab}`, text: loadTabContext(tab) });
  }
  for (const g of GUIDE_PATHS) out.push({ src: `guide:${g}`, text: loadGuide(g) });
  for (const t of ALL_MCP_TOOLS) out.push({ src: `tool:${t.name}`, text: `${t.description}\n${JSON.stringify(t.inputSchema)}` });
  for (const p of PROMPTS) {
    for (const role of ROLES) {
      const args = Object.fromEntries(p.arguments.map((a) => [a.name, 'x']));
      const text = renderPrompt(p, user(role), args).map((m) => JSON.stringify(m.content)).join('\n');
      out.push({ src: `prompt:${p.name}:${role}`, text: `${p.description}\n${text}` });
    }
  }
  for (const r of [...RESOURCES, ...RESOURCE_TEMPLATES]) out.push({ src: `resource:${r.name}`, text: r.description });
  for (const status of [400, 403, 404, 409, 500]) {
    out.push({ src: `error:${status}`, text: structuredError(Object.assign(new Error('x'), { status })).hint });
  }
  out.push({ src: 'error:upstream', text: structuredError(new TypeError('fetch failed')).hint });
  return out;
}
const CORPUS = corpus();

// ─── 1. Tool names ────────────────────────────────────────────────────────────

/** Verbs every OS tool name starts with. A token `<verb>_<rest>` is a tool reference. */
const VERBS = 'list|get|create|update|delete|promote|request|approve|publish|run|search|query|define|ingest|sync|set|use|build|commit|register|import|export|test|configure|retire|decide|add|adopt|revoke|go|start|resume|verify|reindex|index|author|transform|document|profile|classify|apply|propose|suggest|preview|push|read|restore|diff|generate|archive|refresh|reconcile|design|upload|certify';
const TOOL_SHAPED = new RegExp(`\\b(?:${VERBS})_[a-z0-9_]*[a-z0-9]\\b`, 'g');

/** Tool-shaped words that are not tools. Each needs a reason; never add a dead tool here. */
const NOT_TOOLS: Record<string, string> = {
  promote_certify: 'approval kind (core/policy/approvals.ts)',
  run_jobs: 'the run-store table',
  run_events: 'the run-store table',
};

test('CLAIM-TOOLS: every tool name an assistant is told about is a registered tool or prompt', () => {
  const known = new Set([...ALL_MCP_TOOLS.map((t) => t.name), ...PROMPTS.map((p) => p.name), ...Object.keys(NOT_TOOLS)]);
  const dead: string[] = [];
  for (const { src, text } of CORPUS) {
    for (const m of text.matchAll(TOOL_SHAPED)) {
      // `run_1b4e28ba…` style ids in worked examples are run ids, not tools.
      if (/^run_[0-9a-f]+$/.test(m[0])) continue;
      if (!known.has(m[0])) dead.push(`${src}: ${m[0]}`);
    }
  }
  assert.deepEqual([...new Set(dead)], [], `texts name tools that do not exist:\n${[...new Set(dead)].join('\n')}`);
});

// ─── 2. Resources ─────────────────────────────────────────────────────────────

/** URIs that are named but are not MCP resources, with the reason. */
const NOT_RESOURCES: Record<string, string> = {
  'sovereign-os://knowledge/<id>': 'the OKF bundle `resource` field (tabs/knowledge/context.md), not an MCP resource',
};
/** Generic placeholders a guide uses to describe a family of URIs. */
const PLACEHOLDER = /<(type|pathway|resource)>|^sovereign-os:\/\/(guide|my)\/$/;

test('CLAIM-RESOURCES: every sovereign-os:// URI an assistant is told about can be read', () => {
  const exact = new Set(RESOURCES.map((r) => r.uri));
  const prefixes = RESOURCE_TEMPLATES.map((t) => t.uriTemplate.replace(/\{[^}]+\}$/, ''));
  const dead: string[] = [];
  for (const { src, text } of CORPUS) {
    for (const m of text.matchAll(/sovereign-os:\/\/[a-z0-9/<>{}|_-]*[a-z0-9>}/]/g)) {
      const uri = m[0];
      if (uri in NOT_RESOURCES || PLACEHOLDER.test(uri)) continue;
      // `my/<a|b|c>` names three resources at once.
      const alt = uri.match(/^(.*)<([a-z|]+)>$/);
      const uris = alt ? alt[2].split('|').map((x) => alt[1] + x) : [uri];
      for (const u of uris) {
        const ok = exact.has(u) || prefixes.some((p) => u.startsWith(p) && /^(\{id\}|<id>|[a-z0-9_]+)$/.test(u.slice(p.length)));
        if (!ok) dead.push(`${src}: ${u}`);
      }
    }
  }
  assert.deepEqual([...new Set(dead)], [], `texts name resources that do not exist:\n${[...new Set(dead)].join('\n')}`);
});

// ─── 3. Navigation ────────────────────────────────────────────────────────────

const TAB_LABELS = new Set(TAB_GROUPS.flatMap((g) => g.tabs.map((t) => t.label)));
const TAB_KEYS = new Set(TAB_GROUPS.flatMap((g) => g.tabs.map((t) => (t.feature ?? '').toLowerCase())));
const ACCOUNT_LABELS = new Set(ACCOUNT_ITEMS.map((i) => i.label));

test('CLAIM-NAV: the instructions name only tabs and menu items the sidebar has', () => {
  const nav = buildInstructions().match(/NAV \(so you can orient the user\): ([^\n]*)/);
  assert.ok(nav, 'the overview carries a NAV sentence');
  const groups = nav[1].split('. Your account menu')[0];
  const named = [...groups.matchAll(/\(([^)]*)\)/g)].flatMap((m) => m[1].split(' · '));
  for (const label of named) assert.ok(TAB_LABELS.has(label), `NAV names "${label}", which is not a sidebar tab`);
  for (const label of ACCOUNT_LABELS) assert.ok(nav[1].includes(label), `NAV omits the account menu item "${label}"`);
});

test('CLAIM-NAV: the overview guide lists only surfaces that are tabs', () => {
  const rows = [...loadGuide('overview').matchAll(/^\| \*\*([^*]+)\*\* \|/gm)].map((m) => m[1]);
  assert.ok(rows.length >= 5, 'the surfaces table was found');
  for (const r of rows) assert.ok(TAB_LABELS.has(r) || TAB_KEYS.has(r.toLowerCase()), `overview lists "${r}", which is not a tab`);
});

test('CLAIM-NAV: the how-to-use pathway table lists only real guides', () => {
  const guide = loadGuide('how-to-use');
  const table = guide.slice(guide.indexOf('## The golden paths'), guide.indexOf('## Role summary'));
  const paths = [...table.matchAll(/^\| `([a-z-]+)` \|/gm)].map((m) => m[1]);
  assert.ok(paths.length >= 5, 'the pathway table was found');
  for (const p of paths) assert.ok((GUIDE_PATHS as readonly string[]).includes(p), `how-to-use offers guide "${p}", which does not exist`);
});

test('CLAIM-NAV: every "Platform → <section>" an assistant is sent to is a Platform section', () => {
  // Read as text: a core test may not import a tab (check-structure CORE-INDEPENDENCE).
  const src = readFileSync(join(process.cwd(), 'tabs', 'admin', 'lib', 'sections.ts'), 'utf8');
  const sections = new Set([...src.matchAll(/label: '([^']+)'/g)].map((m) => m[1]));
  assert.ok(sections.has('Users & Access'), 'the section table was read');
  const dead: string[] = [];
  for (const { src: from, text } of CORPUS) {
    for (const m of text.matchAll(/Platform (?:→|\\u2192) ([A-Z][A-Za-z&-]*(?: (?:&|[A-Z][A-Za-z-]*))*)/g)) {
      if (!sections.has(m[1])) dead.push(`${from}: Platform → ${m[1]}`);
    }
  }
  assert.deepEqual([...new Set(dead)], [], `texts name Platform sections that do not exist:\n${[...new Set(dead)].join('\n')}`);
});

// ─── 4. Role statements ───────────────────────────────────────────────────────

const ROLE_WORD: Record<string, Role> = { creator: 'creator', builder: 'builder', 'domain admin': 'domain_admin', admin: 'admin' };
const RANK = (r: Role) => ROLES.indexOf(r);

/**
 * Three phrasings tie a role to a tool: "`tool(…)` — **Builder+** only", "⛔ Builder+ only:
 * tool(", and a markdown table row "| ⛔ `tool` … | Builder …". The stated role must be the
 * tool's own floor: lower promises a power the OS refuses; higher hides one it grants.
 */
test('CLAIM-ROLES: a role named next to a tool is that tool’s real floor', () => {
  const floor = new Map(ALL_MCP_TOOLS.map((t) => [t.name, t.minRole as Role]));
  const patterns = [
    /`([a-z_]+)\([^)]*\)`\s*—\s*\**(creator|builder|domain admin|admin)\+?\**\s*only/gi,
    /⛔\s*(?<role>creator|builder|domain admin|admin)\+?\s*only:\s*(?<tool>[a-z_]+)\(/gi,
    /^\|\s*(?:⛔\s*)?`(?<tool>[a-z_]+)`[^|\n]*\|\s*(?<role>creator|builder|domain admin|admin)\b/gim,
  ];
  const wrong: string[] = [];
  for (const { src, text } of CORPUS) {
    for (const re of patterns) {
      for (const m of text.matchAll(re)) {
        const tool = m.groups?.tool ?? m[1];
        const role = ROLE_WORD[(m.groups?.role ?? m[2]).toLowerCase()];
        const real = floor.get(tool);
        if (real && RANK(role) !== RANK(real)) wrong.push(`${src}: ${tool} is said to need ${role}, its floor is ${real}`);
      }
    }
  }
  assert.deepEqual([...new Set(wrong)], [], `role claims that do not match the gate:\n${[...new Set(wrong)].join('\n')}`);
});

async function whoami(role: Role): Promise<{ can: string[]; cannot: string[] }> {
  const res = await handleRpc(user(role), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } });
  const r = (res as { result: { content: { text: string }[] } }).result;
  return JSON.parse(r.content[0].text);
}

test('CLAIM-ROLES: whoami says a role may approve and certify exactly when the gate lets it', async () => {
  for (const role of ROLES) {
    const { can, cannot } = await whoami(role);
    const says = (list: string[], re: RegExp) => list.some((c) => re.test(c));
    assert.equal(says(can, /approve My→Domain/), canPromote(role, 'Personal'), `${role}: approve My→Domain`);
    assert.equal(says(can, /certify to Company/), canPromote(role, 'Shared'), `${role}: certify`);
    assert.equal(says(cannot, /approve a My→Domain/), !canPromote(role, 'Personal'), `${role}: says it cannot approve`);
    // Nobody below the approver is told to ask a role that cannot approve either.
    assert.ok(!says([...can, ...cannot], /ask a Builder/i), `${role}: points at a Builder for an approval`);
  }
});

test('CLAIM-ROLES: whoami offers user administration only to the role the routes accept', async () => {
  // Every Users & Access route enters through adminCtx(), whose first line is requireAdmin().
  const gate = readFileSync(join(process.cwd(), 'app', 'api', 'platform-admin', '_ctx.ts'), 'utf8');
  assert.match(gate, /const user = await requireAdmin\(\)/, 'the user-admin routes are admin-only');
  for (const role of ROLES) {
    const { can } = await whoami(role);
    assert.equal(can.some((c) => /administer users/.test(c)), role === 'admin', `${role}: user administration`);
  }
});

// ─── 5. Error hints ───────────────────────────────────────────────────────────

test('CLAIM-ERRORS: a conflict is never reported as "nothing further to do"', () => {
  // A 409 is also how a real refusal arrives (already decided, blocked, wrong state).
  const { code, hint } = structuredError(Object.assign(new Error('blocked'), { status: 409 }));
  assert.equal(code, 'conflict');
  assert.doesNotMatch(hint, /no further action/i);
  assert.match(hint, /reason/);
});
