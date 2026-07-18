/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * THE PER-TAB TALK CONFIG — the ONE place a Context tab's copilot is described.
 *
 * Each entry pairs the tab's METADATA source (its entitled-scope overview) with its
 * GROUNDING strategy (its EXISTING governed retrieval). Rolling a copilot out to a new
 * tab is a single entry here — the chat UI, the reasoning separation, the budget
 * discipline and the governed spine are all shared (see `talk.ts`).
 *
 * Grounding reuses each tab's real governed path, run AS the caller:
 *   • data       → the /api/data/ask NL→SQL flow (`runAsk` over governed `queryRun`).
 *   • knowledge  → `retrieveKnowledge` (OPA-gated hybrid retrieval, DLS pushed down).
 *   • files      → `searchFiles` (canView-scoped index search).
 *   • metrics    → metadata-only for now (the overview lists the caller's metric defs);
 *   • connections→ metadata-only for now (the overview lists the caller's connections).
 * The last two are deliberately one-line upgrades when a governed retrieval is wired.
 *
 * Server-only (retrieval touches the governed stores + LiteLLM).
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import { config } from '@/lib/core/config';
import { roleModel } from '@/lib/models/roles';
import { runAsk, type AskMessage, type AskOutcome } from '@/lib/data/ask';
import { listAskable, type AskableDataset } from '@/lib/data';
import { readPrincipalFor } from '@/lib/data/store-fqn';
import { queryRun } from '@/lib/infra/governed';
import { liteLlmCaller } from '@/lib/assistant/runtime';
import { retrieveKnowledge } from '@/lib/knowledge/retrieve';
import { searchFiles } from '@/lib/files';
import { getTabMetadata } from './metadata.ts';
import { TALK_PRESENTATION, type TalkCitation, type TalkConfig, type TalkRetrieval, type TalkTabId } from './schema.ts';

/** A Principal is a CurrentUser minus `name`. */
function principal(user: CurrentUser) {
  return { id: user.id, domains: user.domains, role: user.role };
}

// ------------------------------------------------------ data grounding (NL→SQL) --

type DataGrounding = Awaited<ReturnType<TalkRetrieval>>;

/**
 * Map a governed NL→SQL {@link AskOutcome} to the copilot's grounding — a PURE function so
 * the mapping (rows on success, an honest reason on failure) is unit-testable offline.
 *
 * On success the returned rows ARE the evidence. On failure we do NOT swallow the outcome:
 * the failure `kind` + `message` (and the SQL, if one ran) go back as EVIDENCE text so the
 * copilot can say "I tried to query <dataset> but hit <reason>" and ask the user to clarify —
 * instead of silently pretending no data exists (which read as "no data rows" to students).
 * Read-only + governed throughout: this only shapes what already ran; it never re-queries.
 */
export function dataResult(outcome: AskOutcome, datasets: AskableDataset[]): DataGrounding {
  if (!outcome.ok) {
    return {
      kind: 'sql',
      query: outcome.sql,
      evidence: `the data query could not run — ${outcome.kind}: ${outcome.message}`,
      citations: [],
    };
  }
  const shown = outcome.rows.slice(0, 20);
  const evidence = [outcome.columns.join('\t'), ...shown.map((r) => r.join('\t'))].join('\n');
  // The datasets the SQL actually referenced are the citations (matched by FQN substring).
  const cited: TalkCitation[] = datasets
    .filter((d) => outcome.sql.toLowerCase().includes(d.fqn.toLowerCase()))
    .map((d) => ({ id: d.fqn, label: d.name, kind: 'dataset', href: `/data#${d.id}` }));
  return {
    kind: 'sql',
    query: outcome.sql,
    evidence: `query result — ${outcome.rowCount} row${outcome.rowCount === 1 ? '' : 's'}:\n${evidence}`,
    citations: cited,
  };
}

const dataRetrieval: TalkRetrieval = async (question, user) => {
  const datasets = listAskable(principal(user));
  const call = liteLlmCaller();
  const outcome = await runAsk({
    question,
    datasets,
    llm: async (messages: AskMessage[], model: string) => (await call({ model, messages, temperature: 0 })).content,
    // NL→SQL generation runs on the SAME admin-configurable copilot tier as the
    // answer (default `standard`), not a hard-pinned reasoning call — the top-level
    // copilot escalates to reasoning if the resulting answer is weak. Summaries stay
    // on standard. Pin TALK_COPILOT_TIER=reasoning to restore always-235B generation.
    models: { generate: roleModel(config.talkCopilotTier), summarize: roleModel('standard') },
    query: (sql) => queryRun(sql, readPrincipalFor(sql, user)),
  });
  return dataResult(outcome, datasets);
};

// --------------------------------------------------- knowledge grounding (hybrid) --

const knowledgeRetrieval: TalkRetrieval = async (question, user) => {
  // k=4: a tighter top-k keeps the grounded evidence (and so the reasoning INPUT — the
  // real cost multiplier at ~14k tokens/call) small without dropping answer quality on
  // these focused copilot questions. Admin-tunable via TALK_KNOWLEDGE_TOPK.
  const k = Number(process.env.TALK_KNOWLEDGE_TOPK ?? '') || 4;
  const r = await retrieveKnowledge(question, principal(user), { k });
  if (r.decision === 'deny' || r.hits.length === 0) {
    return { kind: 'retrieval', query: question, citations: [] };
  }
  const citations: TalkCitation[] = r.hits.map((h) => ({
    id: h.unit.id,
    label: h.unit.title,
    kind: 'workflow',
    href: `/knowledge#${h.unit.provenance.workflowId ?? h.unit.id}`,
  }));
  const evidence = r.hits
    .map((h) => `# ${h.unit.title}\n${h.unit.text.slice(0, 600)}`)
    .join('\n\n');
  return { kind: 'retrieval', query: question, evidence, citations };
};

// ------------------------------------------------------ files grounding (search) --

const filesRetrieval: TalkRetrieval = (question, user) => {
  const hits = searchFiles(principal(user), question).slice(0, 8);
  if (hits.length === 0) return Promise.resolve({ kind: 'retrieval', query: question, citations: [] });
  const citations: TalkCitation[] = hits.map((h) => ({
    id: h.id,
    label: h.name,
    kind: 'file',
    href: h.deepLink,
  }));
  const evidence = hits.map((h) => `# ${h.name} (${h.kind})\n${h.snippet}`).join('\n\n');
  return Promise.resolve({ kind: 'retrieval', query: question, evidence, citations });
};

// -------------------------------------------- metadata-only grounding (baseline) --

/** For a tab with no governed retrieval wired yet: the pinned overview IS the grounding. */
const metadataOnly: TalkRetrieval = () => Promise.resolve({ kind: 'none', citations: [] });

// --------------------------------------------------------------------- registry --

/** Build a config entry: the shared presentation (schema) + this tab's metadata + retrieval. */
function entry(id: TalkTabId, retrieval: TalkRetrieval): TalkConfig {
  const p = TALK_PRESENTATION[id];
  return { id, title: p.title, blurb: p.blurb, examples: p.examples, metadata: (u) => getTabMetadata(id, u), retrieval };
}

export const TALK_CONFIGS: Record<TalkTabId, TalkConfig> = {
  data: entry('data', dataRetrieval),
  knowledge: entry('knowledge', knowledgeRetrieval),
  files: entry('files', filesRetrieval),
  metrics: entry('metrics', metadataOnly),
  connections: entry('connections', metadataOnly),
};

/** Resolve a tab's copilot config. Throws on an unknown tab (an honest 404 upstream). */
export function getTabConfig(tabId: TalkTabId): TalkConfig {
  const cfg = TALK_CONFIGS[tabId];
  if (!cfg) throw Object.assign(new Error(`No copilot for tab "${tabId}"`), { status: 404 });
  return cfg;
}

/** The tab ids that have a copilot — the client uses this to know a tab is talk-enabled. */
export function talkTabIds(): TalkTabId[] {
  return Object.keys(TALK_CONFIGS) as TalkTabId[];
}
