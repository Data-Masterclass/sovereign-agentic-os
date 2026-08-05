/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { roleAtLeast } from '@/lib/core/session';
import { parseJsonReply } from '@/lib/assistant/json-reply';
import { assistantComplete } from '@/lib/assistant/complete';
import { getConnectionForUser } from '@/lib/connections/store';
import { getCatalogSnapshot } from '@/lib/connections/warehouse/catalog-snapshot';
import { getMergedClassification } from '@/lib/connections/warehouse/catalog-classification';
import { listExposureSets } from '@/lib/connections/exposures';
import { listDomains } from '@/lib/platform-admin/domains';

export const dynamic = 'force-dynamic';

/**
 * The Expose assistant (lakehouse-expose-experience.md, Phase C) — ONE persistent, governed,
 * MULTI-TURN chat mounted across all four Expose stages (Catalog · Organize · Assign · Review).
 * It runs the SAME ONE assistant model every built-in helper uses (`assistantComplete`:
 * Langfuse-audited, cost-cap enforced), inheriting the honest 503 (no model) / 402 (cost cap)
 * errors — no fake-AI fallback. It only SUGGESTS; every mutation runs through the ExposePanel's
 * governed callbacks on an explicit user Apply (admin-gated exactly like the exposure mutations).
 *
 * Grounding (per turn): the REAL catalog snapshot summary (schema/table counts, takenAt, drift),
 * the classification state (category counts + lastRunDetail), the current selection, the REAL
 * domain list, and the existing exposure sets. A suggestion is VALIDATED SERVER-SIDE against
 * that feed before it becomes an Apply card:
 *   • classify   → always allowed (an admin action; the Organize run re-gates in-lib).
 *   • selection  → every `schema.table` must exist in the snapshot (unknown ones refused).
 *   • exposure   → domains must be real domain ids; tables must exist in the snapshot; else
 *                  refused with the honest reason and no card (only the prose stands).
 */

const CAPABILITY =
  'You help a platform admin expose a warehouse catalog to OS domains. You NEVER mutate anything — you only suggest, and the admin clicks Apply. Exposure compiles to policy: an unexposed external table reads zero rows for everyone.';

type Turn = { role: 'user' | 'assistant'; content: string };

/** Coerce the request `messages` into a clean, bounded turn list. */
function readTurns(body: Record<string, unknown>): Turn[] {
  const raw = Array.isArray(body.messages) ? body.messages : [];
  const turns: Turn[] = [];
  for (const m of raw.slice(-12)) {
    if (!m || typeof m !== 'object') continue;
    const role = (m as Record<string, unknown>).role;
    const content = (m as Record<string, unknown>).content;
    if ((role === 'user' || role === 'assistant') && typeof content === 'string' && content.trim()) {
      turns.push({ role, content: content.slice(0, 4000) });
    }
  }
  return turns;
}

const systemPrompt = [
  'You are the Expose assistant for a platform admin exposing warehouse tables to OS domains.',
  CAPABILITY,
  'Respond with STRICT JSON (no prose outside it, no code fences):',
  '{ "message": string (markdown; a short, friendly explanation),',
  '  "classify"?: true  (include ONLY when the user asks to organize/classify the catalog with AI),',
  '  "selection"?: { "tables": ["schema.table", ...] }  (real tables from the snapshot to select),',
  '  "exposure"?: { "name"?: string, "domains": ["domain-id", ...], "mode"?: "live"|"sync", "tier"?: "silver"|"gold", "tables": ["schema.table", ...] } }',
  'Use ONLY schema.table names present in the "Catalog snapshot" list and ONLY domain ids from the "Domains" list — never invent a table or a domain. If you are missing them, ask a clarifying question in "message" and omit the structured suggestion.',
  'Prefer ONE suggestion per turn (classify OR selection OR exposure).',
].join('\n');

/** A compact, real grounding block for the turn. */
async function contextBlock(connId: string, user: CurrentUser, catalog: string): Promise<{ block: string; tableKeys: Set<string>; domainIds: Set<string> }> {
  const [snapshot, classification, sets] = await Promise.all([
    getCatalogSnapshot(connId, user),
    getMergedClassification(connId, user),
    listExposureSets(connId, user),
  ]);
  const domains = listDomains().filter((d) => !d.archived);
  const domainIds = new Set(domains.map((d) => d.id));

  const tableKeys = new Set<string>();
  const lines: string[] = [];
  if (!snapshot) {
    lines.push('Catalog snapshot: none taken yet — the admin should Refresh before selecting tables.');
  } else {
    for (const t of snapshot.tables) tableKeys.add(`${t.schema}.${t.table}`);
    lines.push(
      `Catalog ${catalog}: snapshot from ${snapshot.takenAt} (${snapshot.status}), ${snapshot.tables.length} table(s); ` +
        `drift since previous: +${snapshot.prevDiff.added.length}/−${snapshot.prevDiff.removed.length}.`,
    );
    lines.push('Catalog snapshot (schema.table) — reference ONLY these:');
    lines.push(snapshot.tables.map((t) => `${t.schema}.${t.table}`).join('\n'));
  }

  // Classification state: category counts + honest last-run detail.
  const counts: Record<string, number> = {};
  for (const p of Object.values(classification.placements)) counts[p.category] = (counts[p.category] ?? 0) + 1;
  lines.push(
    classification.seed
      ? `Organization: seeded (${classification.seed}); folders ${classification.taxonomy.map((t) => `${t.name} (${counts[t.id] ?? 0})`).join(', ')}.` +
          (classification.lastRunDetail ? ` Last AI run: ${classification.lastRunDetail}` : ' No AI run yet.')
      : 'Organization: no folders chosen yet — the admin can "Organize this catalog with AI" to set one up.',
  );

  lines.push(
    'Domains (id — name) — reference ONLY these ids:',
    domains.length ? domains.map((d) => `${d.id} — ${d.name}`).join('\n') : '(no domains found)',
  );

  const active = sets.filter((e) => !e.revoked);
  lines.push(
    active.length
      ? `Existing exposure sets: ${active.map((e) => `${e.name} → ${e.domains.join('/')} (${e.mode}/${e.tier}, ${e.tables.length} tables)`).join('; ')}.`
      : 'Existing exposure sets: none yet.',
  );

  return { block: lines.join('\n'), tableKeys, domainIds };
}

/** Validate a selection suggestion — keep ONLY tables present in the snapshot. */
function validateSelection(raw: unknown, tableKeys: Set<string>): { tables: string[] } | { error: string } {
  const o = raw as { tables?: unknown };
  const asked = Array.isArray(o?.tables) ? o.tables.map((t) => String(t).trim()).filter(Boolean) : [];
  if (asked.length === 0) return { error: 'named no tables' };
  const real = asked.filter((t) => tableKeys.has(t));
  const missing = asked.filter((t) => !tableKeys.has(t));
  if (real.length === 0) return { error: `named ${missing.length === 1 ? 'a table' : 'tables'} that are not in this catalog snapshot (${missing.slice(0, 3).join(', ')})` };
  return { tables: real };
}

/** Validate an exposure suggestion — real domains + real tables, else refuse with a reason. */
function validateExposure(
  raw: unknown,
  tableKeys: Set<string>,
  domainIds: Set<string>,
): { name?: string; domains: string[]; mode?: 'live' | 'sync'; tier?: 'silver' | 'gold'; tables: string[] } | { error: string } {
  const o = raw as { name?: unknown; domains?: unknown; mode?: unknown; tier?: unknown; tables?: unknown };
  const askedDomains = Array.isArray(o?.domains) ? o.domains.map((d) => String(d).trim()).filter(Boolean) : [];
  const askedTables = Array.isArray(o?.tables) ? o.tables.map((t) => String(t).trim()).filter(Boolean) : [];
  const domains = askedDomains.filter((d) => domainIds.has(d));
  const badDomains = askedDomains.filter((d) => !domainIds.has(d));
  if (domains.length === 0) {
    return { error: badDomains.length ? `named ${badDomains.length === 1 ? 'a domain' : 'domains'} that do not exist (${badDomains.slice(0, 3).join(', ')})` : 'named no domain' };
  }
  const tables = askedTables.filter((t) => tableKeys.has(t));
  if (tables.length === 0) {
    return { error: askedTables.length ? `named ${askedTables.length === 1 ? 'a table' : 'tables'} not in this catalog snapshot` : 'named no tables' };
  }
  const mode = o.mode === 'sync' ? 'sync' : o.mode === 'live' ? 'live' : undefined;
  const tier = o.tier === 'gold' ? 'gold' : o.tier === 'silver' ? 'silver' : undefined;
  const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : undefined;
  return { ...(name ? { name } : {}), domains, ...(mode ? { mode } : {}), ...(tier ? { tier } : {}), tables };
}

export const POST = withRoute<{ id: string }, Record<string, unknown>>(async ({ user, params, body }) => {
    const id = params.id;
    const c = await getConnectionForUser(id, user); // 404s if not visible
    // Admin-gated exactly like the exposure mutations this assistant proposes.
    if (!roleAtLeast(user.role, 'admin')) {
      return NextResponse.json({ error: 'The Expose assistant is available to platform admins.' }, { status: 403 });
    }
    const catalog = c.warehouse?.catalog ?? c.endpoint;

    const turns = readTurns(body ?? {});
    if (turns.length === 0) turns.push({ role: 'user', content: 'Help me expose tables from this catalog.' });

    const { block, tableKeys, domainIds } = await contextBlock(id, user, catalog);
    const messages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: block },
      ...turns,
    ];

    const { content } = await assistantComplete(messages, { user: { id: user.id, domains: user.domains } });
    const parsed = parseJsonReply(content);
    const obj = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    let message = (obj && typeof obj.message === 'string' && obj.message) || content || 'The assistant did not return a usable result — try rephrasing.';

    type ValidExposure = { name?: string; domains: string[]; mode?: 'live' | 'sync'; tier?: 'silver' | 'gold'; tables: string[] };
    const suggestions: { classify?: boolean; selection?: { tables: string[] }; exposure?: ValidExposure } = {};

    if (obj?.classify === true) suggestions.classify = true;

    if (obj?.selection && typeof obj.selection === 'object') {
      const v = validateSelection(obj.selection, tableKeys);
      if ('error' in v) message += `\n\n_I can’t offer that selection as a one-click apply — it ${v.error}. Take a snapshot / refresh, then ask again._`;
      else suggestions.selection = v;
    }

    if (obj?.exposure && typeof obj.exposure === 'object') {
      const v = validateExposure(obj.exposure, tableKeys, domainIds);
      if ('error' in v) message += `\n\n_I can’t offer that exposure as a one-click apply — it ${v.error}. Pick real domains and tables and I’ll prefill it._`;
      else suggestions.exposure = v;
    }

    return NextResponse.json({ message, suggestions });
}, { parse: true, defaultStatus: 500 });
