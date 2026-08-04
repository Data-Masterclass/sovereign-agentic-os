/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { getDataset, ensureHydrated as ensureDataHydrated, type Principal } from '@/lib/data/store';
import { getWorkflow, ensureHydrated as ensureWorkflowsHydrated } from '@/lib/knowledge/store';
import { getPersonalKnowledge, ensureHydrated as ensurePersonalHydrated } from '@/lib/knowledge/personal-store';
import { getMetric } from '@/lib/metrics/store';
import { getFile, ensureHydrated as ensureFilesHydrated } from '@/lib/files/store';
import { getConnectionForUser } from '@/lib/connections/store';
import { estimateTokens, truncateToTokens } from '@/lib/infra/context/context-assembler';
import { CONTEXT_KINDS, type ContextGrants, type ContextKind } from '@/lib/core/context-grants';
import type { CurrentUser } from '@/lib/core/auth';

/**
 * GRANTS → AUTHORING CONTEXT (Piece 1 of the grants wave).
 *
 * The audit finding this closes: a Software app's `app.grants` (the datasets, knowledge,
 * files, metrics and connections a builder deliberately granted the app) were STORED but
 * never fed to the agents that DESIGN the spec or BUILD the code — so those agents invented
 * column names, metric members and connection shapes instead of building against the real,
 * governed artifacts the app was granted.
 *
 * This module resolves each granted id to its REAL content and assembles a "## Granted
 * context" block for the Design / Build / stage-directive prompts. It resolves through the
 * SAME governed, DLS/RLS-scoped getters the grant picker's feed (available-context.ts) uses,
 * READ AS the acting user — so it can NEVER surface content the caller could not already see.
 * A grant whose target the caller can no longer view (revoked, archived, moved) is OMITTED,
 * not errored: the block degrades honestly.
 *
 * Token-budgeted with the shared context-assembler primitives (estimateTokens /
 * truncateToTokens): each artifact is capped, and the whole block is capped so it can never
 * dominate a prompt. When the budget forces items to be dropped, the truncation is LOUD
 * ("…truncated — N more granted items omitted to fit context"), never silent.
 *
 * Empty grants ⇒ '' (no header, zero prompt cost).
 */

/** Overall cap for the whole "## Granted context" block (a few thousand tokens). */
const TOTAL_TOKEN_BUDGET = 3000;
/** Per-artifact cap on the free-text body (schema docs / knowledge md / file text). */
const PER_ARTIFACT_TOKEN_CAP = 500;

/** The three plain access levels, shown so the prompt knows read vs write scope. */
const ACCESS_LABEL: Record<string, string> = {
  'read-only': 'read',
  'read-propose': 'read+propose',
  'read-write': 'read+write',
};

/** File kinds whose content is NOT text — we surface name + type only, never bytes. */
const BINARY_FILE_KINDS = new Set(['image', 'video', 'audio', 'archive']);

type ResolvedItem = { header: string; body: string };

function principalOf(user: CurrentUser): Principal {
  return { id: user.id, domains: user.domains, role: user.role };
}

/** Trim + collapse a possibly-large text body to its per-artifact token cap (loud marker). */
function capBody(text: string): string {
  const clean = (text ?? '').trim();
  if (!clean) return '';
  return truncateToTokens(clean, PER_ARTIFACT_TOKEN_CAP);
}

/** DATA → name, description, tier, column docs (+types via measures) — DLS-scoped. */
function resolveDataItem(id: string, access: string, user: CurrentUser): ResolvedItem | null {
  const d = getDataset(id, principalOf(user)); // throws if not viewable → caught by caller
  const header = `### Data · ${d.name} [${ACCESS_LABEL[access] ?? access}] (id: ${id}, tier: ${d.tier})`;
  const lines: string[] = [];
  if (d.description) lines.push(d.description);
  // Column docs are the governed "gold/current schema" the transparency gate requires —
  // real column names + their plain-language docs, so the agent uses the exact names.
  const cols = (d.columns ?? []).filter((c) => c.name);
  if (cols.length) {
    lines.push('Columns:');
    for (const c of cols) lines.push(`- ${c.name}${c.description ? ` — ${c.description}` : ''}`);
  }
  // Measures are the queryable members (name + type) — the metric surface over this dataset.
  const measures = (d.measures ?? []).filter((m) => m.name);
  if (measures.length) {
    lines.push('Measures (members): ' + measures.map((m) => `${m.label ?? m.name} (${m.type})`).join(', '));
  }
  return { header, body: capBody(lines.join('\n')) };
}

/** KNOWLEDGE → title + content (workflow or personal note), capped — DLS-scoped. */
function resolveKnowledgeItem(id: string, access: string, user: CurrentUser): ResolvedItem | null {
  const p = principalOf(user);
  // Ids are prefixed: `wf_…` = workflow, `pk_…` = personal knowledge. Try the matching store;
  // fall back to the other so a mis-prefixed legacy id still resolves. Both getters DLS-gate.
  let title = '';
  let md = '';
  if (id.startsWith('wf')) {
    const w = getWorkflow(id, p);
    title = w.title;
    md = w.md;
  } else {
    const k = getPersonalKnowledge(id, p);
    title = k.title;
    md = k.md;
  }
  const header = `### Knowledge · ${title} [${ACCESS_LABEL[access] ?? access}] (id: ${id})`;
  return { header, body: capBody(md) };
}

/** FILES → name + text content (cap); binary → name + type only — DLS-scoped. */
function resolveFileItem(id: string, access: string, user: CurrentUser): ResolvedItem | null {
  const v = getFile(id, principalOf(user)); // throws if not viewable → caught by caller
  const name = v.asset.name;
  const kind = v.asset.kind;
  const header = `### File · ${name} [${ACCESS_LABEL[access] ?? access}] (id: ${id}, type: ${kind})`;
  if (BINARY_FILE_KINDS.has(kind)) {
    return { header, body: `(binary ${kind} — ${v.bytes} bytes; content not inlined)` };
  }
  return { header, body: capBody(v.text) };
}

/** METRICS → name, description, member, definition/formula — DLS-scoped. */
function resolveMetricItem(id: string, access: string, user: CurrentUser): ResolvedItem | null {
  const m = getMetric(id, principalOf(user)); // throws if not viewable → caught by caller
  const name = m.measure.label ?? m.measure.name;
  const header = `### Metric · ${name} [${ACCESS_LABEL[access] ?? access}] (id: ${id})`;
  const lines: string[] = [`Member: ${m.member}`];
  if (m.measure.description) lines.push(m.measure.description);
  // The definition/formula — the composite formula the user wrote, else the compiled SQL.
  const definition = m.measure.formula ?? m.measure.sql;
  if (definition) lines.push(`Definition: ${definition}`);
  return { header, body: capBody(lines.join('\n')) };
}

/** CONNECTIONS → name, type, descriptor — NEVER secrets/credentials — DLS-scoped. */
async function resolveConnectionItem(id: string, access: string, user: CurrentUser): Promise<ResolvedItem | null> {
  const c = await getConnectionForUser(id, user); // throws if not viewable → caught by caller
  const header = `### Connection · ${c.name} [${ACCESS_LABEL[access] ?? access}] (id: ${id})`;
  // Descriptor only — type, connector family, template and endpoint metadata. The secret
  // (secretRef / secretFingerprint / auth) is DELIBERATELY excluded and never read here.
  const lines = [
    `Type: ${c.type}; connector: ${c.connector}; template: ${c.template}`,
    c.endpoint ? `Endpoint: ${c.endpoint}` : '',
  ].filter(Boolean);
  return { header, body: capBody(lines.join('\n')) };
}

/** Resolve ONE granted item of a kind, returning null when it is not viewable (OMIT). */
async function resolveItem(
  kind: ContextKind,
  id: string,
  access: string,
  user: CurrentUser,
): Promise<ResolvedItem | null> {
  try {
    switch (kind) {
      case 'data':
        return resolveDataItem(id, access, user);
      case 'knowledge':
        return resolveKnowledgeItem(id, access, user);
      case 'files':
        return resolveFileItem(id, access, user);
      case 'metrics':
        return resolveMetricItem(id, access, user);
      case 'connections':
        return await resolveConnectionItem(id, access, user);
    }
  } catch {
    // DLS-denied / archived / missing → OMIT this item, never error the whole block.
    return null;
  }
  return null;
}

/**
 * Build the "## Granted context" block for an app's grants, resolved AS `user`. Returns
 * '' when there are no grants OR nothing the caller may see (zero prompt cost). Items are
 * assembled kind-by-kind in the stable CONTEXT_KINDS order; assembly stops when the total
 * token budget is reached and the remaining count is reported LOUDLY.
 */
export async function resolveGrantedContext(
  grants: ContextGrants | undefined,
  user: CurrentUser,
): Promise<string> {
  if (!grants) return '';
  const total = CONTEXT_KINDS.reduce((n, k) => n + grants[k].length, 0);
  if (total === 0) return '';

  // Hydrate the mock stores exactly as the grant-picker feed does (best-effort).
  await Promise.all([
    ensureDataHydrated().catch(() => {}),
    ensureWorkflowsHydrated().catch(() => {}),
    ensurePersonalHydrated().catch(() => {}),
    ensureFilesHydrated().catch(() => {}),
  ]);

  // A flat, order-preserving list of (kind, id, access) to resolve.
  const requests: { kind: ContextKind; id: string; access: string }[] = [];
  for (const kind of CONTEXT_KINDS) {
    for (const g of grants[kind]) requests.push({ kind, id: g.id, access: g.access });
  }

  const header = '## Granted context';
  const intro =
    'The app is granted the governed artifacts below (resolved as you, DLS-scoped). BUILD AGAINST THIS: use these exact dataset column names, metric members and connection shapes — do NOT invent fields, members or endpoints.';
  const parts: string[] = [header, intro];
  let used = estimateTokens(header) + estimateTokens(intro);

  let rendered = 0;
  let omittedForBudget = 0;
  let omittedDenied = 0;

  for (const { kind, id, access } of requests) {
    const item = await resolveItem(kind, id, access, user);
    if (!item) {
      omittedDenied += 1;
      continue;
    }
    const block = item.body ? `${item.header}\n${item.body}` : item.header;
    const cost = estimateTokens(block) + 2; // +2 for the blank-line separator
    if (used + cost > TOTAL_TOKEN_BUDGET && rendered > 0) {
      // Budget hit after at least one item — stop and report the rest loudly.
      omittedForBudget += 1;
      continue;
    }
    parts.push('', block);
    used += cost;
    rendered += 1;
  }

  // If literally nothing resolved (every grant now DLS-denied), emit no block.
  if (rendered === 0) return '';

  if (omittedForBudget > 0) {
    parts.push('', `…truncated — ${omittedForBudget} more granted item(s) omitted to fit context.`);
  }
  if (omittedDenied > 0) {
    parts.push('', `(${omittedDenied} granted item(s) not shown — no longer visible to you.)`);
  }
  return parts.join('\n');
}
