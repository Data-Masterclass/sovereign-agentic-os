/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * FEATURE:    The semantic-layer-first and truncation-honesty rules for chat-to-data.
 *
 * USER STORY: As a user asking "what was revenue last month" I want the answer to come
 *             from the one governed metric definition rather than from SQL a model
 *             invented, and I never want a confident total computed over a clipped
 *             result set.
 *
 * ARCHITECTURE:
 *   The three rules below are the ONE source of truth for a sentence that has to appear
 *   in four places at once: the Ask-the-OS system prompt (`OS_RULES` in
 *   `core/runtime/agent-loop.ts`) and the four MCP guides an external client reads
 *   (`core/guides/overview.guide.md`, `tabs/{metrics,dashboards,data}/guide.md`). A
 *   content tripwire test asserts the identical string is present in all five, so the
 *   rule cannot be deleted from one surface and survive in another.
 *
 *   Pure strings: no imports, no `server-only`, so both the prompt builder and the
 *   tripwire test can read them. The rules are POLICY TEXT, not enforcement — the
 *   structural guarantees live in the artifact payloads (`core/runtime/chat-artifacts.ts`)
 *   and in the per-node tool allowlists. A prompt is a nudge; the banner is the promise.
 */

/**
 * C2 / C-R2.1 — the semantic-layer-first rule. One sentence, verbatim, in the system
 * prompt and in all four guides.
 */
export const SEMANTIC_LAYER_RULE =
  'For any question about a NUMBER, go through the semantic layer first: `list_metrics` → `query_metric`. ' +
  'Use `query_data` only when no governed metric member exists for the question, and then always show the ' +
  'SQL you ran and the row bound that applied.';

/**
 * C5 / C-R1.3 — never aggregate a clipped result. `QUERY_MAX_ROWS` clips to the FIRST n
 * rows, not a sample, so a total computed over them is simply wrong.
 */
export const TRUNCATION_RULE =
  'NEVER aggregate, total, average or summarise a TRUNCATED result set. When a tool result carries ' +
  '`truncated: true`, the rows you were given are the FIRST n rows at the `rowLimit` ceiling — not a ' +
  'sample — so any number you compute over them is wrong. Say that the result was clipped, repeat the ' +
  "tool's own `message` verbatim, and offer a narrower query or a governed metric instead.";

/**
 * C6 / C-R2.4 — an ad-hoc SQL answer is labelled as such. A number from `query_data` has
 * no human-authored definition behind it; a number from `query_metric` does.
 */
export const AD_HOC_RULE =
  'An answer computed with `query_data` is AD HOC AND UNVERIFIED: say so in the answer, because the ' +
  'aggregation and the joins were chosen by you and not by the governed metric definition everyone else ' +
  'reads. A `query_metric` answer is the governed number and needs no such caveat.';

/** The block appended to `OS_RULES`, in the prompt's own voice. */
export const ASK_RULES_BLOCK = [
  'ANSWERING A QUESTION ABOUT DATA (the semantic layer comes first):',
  `• ${SEMANTIC_LAYER_RULE}`,
  `• ${AD_HOC_RULE}`,
  `• ${TRUNCATION_RULE}`,
  '• Never do arithmetic on numbers yourself when a tool can compute them. Every number you state',
  '  must come from a governed tool result you can point at.',
].join('\n');

/**
 * The markdown section appended to each of the four MCP guides. Identical bytes in every
 * guide so the tripwire is a simple substring check, and so an external MCP client reading
 * any one of them gets the same instruction the in-app assistant has.
 */
export const ASK_GUIDE_SECTION = [
  '## Answering a question about a number (chat to the data)',
  '',
  SEMANTIC_LAYER_RULE,
  '',
  AD_HOC_RULE,
  '',
  TRUNCATION_RULE,
  '',
  'Discovery companions widen what you can SEE, never what you may DO: `query_metric` pulls in',
  '`list_metrics`, `get_metric` and `get_dataset`; `create_dashboard` pulls in `list_dashboards`,',
  '`list_metrics` and `get_dataset`.',
].join('\n');

/** The guide files that must carry {@link ASK_GUIDE_SECTION}, relative to `os-ui/`. */
export const ASK_RULE_GUIDE_FILES = [
  'core/guides/overview.guide.md',
  'tabs/metrics/guide.md',
  'tabs/dashboards/guide.md',
  'tabs/data/guide.md',
] as const;
