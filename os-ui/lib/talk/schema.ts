/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * "Talk to <Tab>" — the SHARED TYPES for the read-only, governed copilot that every
 * Context tab (Data · Knowledge · Files · Connections · Metrics) gets from one config
 * entry. A tab's copilot is defined ENTIRELY by a {@link TalkConfig}: its metadata
 * source (the entitled-scope overview the reasoning model is grounded on) and its
 * grounding strategy (the tab's EXISTING governed retrieval — NL→SQL for data, hybrid
 * retrieval for knowledge/files, …). Nothing here does IO; it only names the seams.
 */
import type { CurrentUser } from '@/lib/core/auth';

/** The five Context tabs that get a copilot. Add an id here + a config entry to roll one out. */
export type TalkTabId = 'data' | 'knowledge' | 'files' | 'connections' | 'metrics';

/**
 * The CLIENT-SAFE presentation of a tab's copilot (title · blurb · examples). Kept here in
 * the pure schema so a `'use client'` page can import it WITHOUT dragging in the server-only
 * retrieval config. `TALK_CONFIGS` (server) reuses these so the two never drift.
 */
export type TalkPresentation = { title: string; blurb: string; examples: string[] };

export const TALK_PRESENTATION: Record<TalkTabId, TalkPresentation> = {
  data: {
    title: 'Talk to Data',
    blurb:
      'Ask in plain language. The OS turns it into a governed read-only query over the datasets you can see, then answers from the rows — nothing invented.',
    examples: [
      'What was total revenue last month by product?',
      'Which datasets can I query, and what do they hold?',
      'Show the top 10 customers by order value.',
    ],
  },
  knowledge: {
    title: 'Talk to Knowledge',
    blurb:
      'Ask about your workflows, rules and tacit knowledge. Answers are grounded in the knowledge you can access, with sources.',
    examples: [
      'How do we onboard a new data product?',
      'What are the rules for promoting a dataset to Shared?',
      'Summarize what we know about the returns process.',
    ],
  },
  files: {
    title: 'Talk to Files',
    blurb:
      'Ask across your files. The OS searches what you can see and answers from the matching documents, citing each file.',
    examples: [
      'Which files mention the Q3 migration?',
      'Find the onboarding checklist.',
      'What contracts do I have tagged legal?',
    ],
  },
  metrics: {
    title: 'Talk to Metrics',
    blurb: 'Ask about your metric definitions and the datasets behind them, grounded in the metrics you can access.',
    examples: [
      'Which metrics are defined over the orders dataset?',
      'What does the revenue metric measure?',
      'List my personal metrics.',
    ],
  },
  connections: {
    title: 'Talk to Connections',
    blurb: 'Ask about your connections and their capabilities, grounded in the connections you can access.',
    examples: [
      'Which connections can read from Google Drive?',
      'What tools does my Slack connection expose?',
      'List my live connections.',
    ],
  },
};

/** One conversational turn as the UI holds it (user question → grounded assistant answer). */
export type TalkTurn = { role: 'user' | 'assistant'; content: string };

/** A real provenance chip — a thing the caller can actually open (never a fabricated URL). */
export type TalkCitation = {
  /** Stable id of the cited artifact (dataset FQN, workflow id, file id, metric id, connection id). */
  id: string;
  /** Human label for the chip. */
  label: string;
  /** In-app deep link if the tab exposes one; omitted rather than invented. */
  href?: string;
  /** What kind of thing this is (drives the chip icon/wording). */
  kind: 'dataset' | 'workflow' | 'file' | 'metric' | 'connection';
};

/**
 * The grounding a tab's governed retrieval produced for one question — surfaced to the
 * user under a "what ran" disclosure. `query` is the human-readable thing that executed
 * (the SQL for data, the retrieval query for knowledge/files); `evidence` is the compact
 * grounding text the answer was written from. Both are optional: an honest "nothing you
 * can see answers this" turn carries neither.
 */
export type TalkGrounding = {
  /** The tab's retrieval kind, for labelling the disclosure. */
  kind: 'sql' | 'retrieval' | 'none';
  /** The exact governed query that ran (SQL / search query). */
  query?: string;
  /** The compact evidence the model was grounded on (rows preview / retrieved snippets). */
  evidence?: string;
  citations: TalkCitation[];
};

/**
 * The result of one governed `talkTo` turn. The model's REASONING is returned SEPARATELY
 * from the answer — never concatenated — so the UI can show a muted "Thinking" panel
 * distinct from the prominent grounded answer.
 */
export type TalkResult = {
  ok: boolean;
  /** The grounded, plain-language answer. Present even on honest "no data" turns. */
  answer: string;
  /**
   * The model's own reasoning_content, VERBATIM and LABELLED as reasoning. Empty string
   * when the model/gateway returned none. NEVER merged into `answer`.
   */
  reasoning: string;
  /** Real provenance — only ids the caller was entitled to see. */
  citations: TalkCitation[];
  /** What the tab's governed retrieval actually ran (the transparency disclosure). */
  grounding: TalkGrounding;
  /** Honest failure kind, when `ok` is false (e.g. the retrieval was denied / unreachable). */
  kind?: 'no_context' | 'retrieval_failed' | 'model_failed';
};

/**
 * The per-tab metadata overview — the compact, entitled-scope structured summary that is
 * PINNED into the model's context (so it always knows the shape of what the caller owns).
 * `text` is the rendered overview; `citations` are the real artifacts it names.
 */
export type TabMetadata = {
  tabId: TalkTabId;
  /** Rendered, compact overview of the caller's entitled scope for this tab. */
  text: string;
  /** The artifacts named in the overview — the citation pool for this turn. */
  citations: TalkCitation[];
};

/**
 * A tab's governed retrieval for ONE question, run AS the caller. Returns the evidence the
 * answer will be grounded on, the human-readable query that ran, and the real citations.
 * Injected by each {@link TalkConfig}; the reference (data) wraps the /api/data/ask NL→SQL
 * path, knowledge/files wrap their hybrid retrieval, etc. Read-only by construction.
 */
export type TalkRetrieval = (
  question: string,
  user: CurrentUser,
) => Promise<{
  kind: TalkGrounding['kind'];
  query?: string;
  evidence?: string;
  citations: TalkCitation[];
}>;

/** The metadata source for a tab — DLS-scoped, run AS the caller. */
export type TabMetadataSource = (user: CurrentUser) => Promise<TabMetadata> | TabMetadata;

/**
 * A tab's copilot, fully described. One entry per Context tab; the ONLY thing that differs
 * between tabs is the metadata source and the grounding strategy — the chat UI, the budget
 * discipline, the reasoning separation and the governed spine are shared.
 */
export type TalkConfig = {
  id: TalkTabId;
  /** "Talk to Data", … — the panel title. */
  title: string;
  /** One-line description under the title. */
  blurb: string;
  /** Example prompts shown as clickable chips (seed the empty state). */
  examples: string[];
  /** The entitled-scope metadata overview (pinned into context). */
  metadata: TabMetadataSource;
  /** The tab's existing governed retrieval (the grounding). */
  retrieval: TalkRetrieval;
};
