/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import type { ReactNode } from 'react';

/**
 * StageConversation — the reusable "the assistant IS the flow" composition primitive
 * for guided-builder stages.
 *
 * The design law (Alex): in these tabs the assistant is not a stapled-on addon — the
 * CONVERSATION is the primary way the user acts in a stage. Structured UI (trees,
 * forms, buttons) is the assistant's visible RESULT and the direct-manipulation
 * alternative, never a parallel second surface. This primitive lays out exactly that:
 *
 *   ┌───────────────────────────────────────────────────────────┐
 *   │  context      (what am I working on · mode · quiet hint)   │  ← header
 *   ├──────────────┬────────────────────────────────────────────┤
 *   │  structure   │  conversation                              │
 *   │  (the tree,  │  (the scoped thread + the stage actions    │  ← body
 *   │   reflects   │   that are PROMPTS into it + its input)    │
 *   │   outcomes)  │                                            │
 *   ├──────────────┴────────────────────────────────────────────┤
 *   │  outcome      (what the conversation produced — diffs,     │  ← sink
 *   │               status, previews: cause → effect)           │
 *   └───────────────────────────────────────────────────────────┘
 *
 * CONTRACT (what a stage supplies):
 *   • `context`  — a calm one-line header: the current scope, the mode toggle, a hint.
 *                  NEVER a functionality dump; NEVER a second assistant.
 *   • `structure`— the structured reflection of the conversation's work (e.g. the
 *                  epic tree). It is the direct-manipulation SELECTOR that scopes the
 *                  conversation, and it mirrors state the conversation changed. Optional
 *                  (a stage with no structure renders a single-column conversation).
 *   • `conversation` — the ONE scoped thread for the stage, with the stage's primary
 *                  actions rendered as prompts INTO it (clicking an action = the
 *                  conversation takes that turn, visibly). This is the center of gravity.
 *   • `outcome`  — the structured OUTCOME sink: what the conversation just achieved,
 *                  in concrete human terms (files changed, status, preview). Optional.
 *
 * This is layout only — no fetch, no governance, no state. Each stage keeps its own
 * conversation component (BuildChat, StageAssistantChat, …) and passes it as
 * `conversation`; the primitive just guarantees the one-flow composition + rhythm so
 * every stage feels the same. A follow-up wave applies it to Define/Design/Preview/Operate.
 */
export default function StageConversation({
  context,
  structure,
  conversation,
  outcome,
  anchorProps,
  reverse = false,
}: {
  context: ReactNode;
  structure?: ReactNode;
  conversation: ReactNode;
  outcome?: ReactNode;
  /** Optional tutorial-anchor attributes spread onto the root. */
  anchorProps?: Record<string, unknown>;
  /**
   * Put the CONVERSATION on the left and the STRUCTURE on the right (default is
   * structure-left). Design uses this — assistant-left, epics-right — where there is no
   * build-tree to anchor the left; every other stage keeps the default. Layout only.
   */
  reverse?: boolean;
}) {
  const structureCol = structure ? <div className="stage-conversation-structure">{structure}</div> : null;
  const threadCol = <div className="stage-conversation-thread">{conversation}</div>;
  return (
    <div className="stage-conversation" {...anchorProps}>
      {context ? <div className="stage-conversation-context">{context}</div> : null}

      <div className={`stage-conversation-body${structure ? '' : ' is-solo'}`}>
        {reverse ? <>{threadCol}{structureCol}</> : <>{structureCol}{threadCol}</>}
      </div>

      {outcome ? <div className="stage-conversation-outcome">{outcome}</div> : null}
    </div>
  );
}
