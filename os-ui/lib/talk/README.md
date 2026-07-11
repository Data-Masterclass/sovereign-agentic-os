<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Talk — the "Talk to <Tab>" copilot foundation

A consistent, **read-only, governed** copilot for every Context tab (Data · Knowledge ·
Files · Metrics · Connections). One config entry lights a tab up. The chat shows the
model's **reasoning apart from the answer** — thinking is muted and collapsible, the
grounded answer is prominent.

## Golden path

```
question ─▶ getTabMetadata(tab, user)     entitled-scope overview (DLS-scoped)  ─┐  PINNED
        └▶ config.retrieval(question, user) the tab's EXISTING governed retrieval ─┤  evidence
                                            (NL→SQL / hybrid retrieval), read-only  │
   assembleContext(budget = inputBudget(reasoning model))  ── HARD input ceiling ──┘
        └▶ roleModel('reasoning')  ── answer  +  reasoning_content (SEPARATE) ──▶ TalkResult
                                            traced to Langfuse via infra/governed
```

Everything runs **AS the caller**: the metadata `list_*` sources and the tab retrieval use
the same visibility gate as the tab UI, so a copilot never surfaces an unentitled artifact.
The whole turn is one governed `trace({ tool: 'talk' })`.

## Public API (`index.ts`)

- `talkTo(tab, question, user, history?, { llm?, now? })` → `TalkResult`
  (`{ answer, reasoning, citations, grounding }` — reasoning is NEVER merged into answer).
- `getTabMetadata(tab, user)` — the DLS-scoped entitled-scope overview.
- `getTabConfig(tab)`, `talkTabIds()`, `TALK_CONFIGS` — the per-tab registry.
- Types: `TalkTabId`, `TalkResult`, `TalkTurn`, `TalkCitation`, `TalkGrounding`, `TalkConfig`.
- `TALK_PRESENTATION` (in `schema.ts`) — the **client-safe** title/blurb/examples a
  `'use client'` page imports without dragging in the server-only retrieval config.

HTTP: `POST /api/talk/[tab]` `{ question, history? }` → `TalkResult` JSON. Session-gated
(`requireUser`, 401 anon); unknown tab 404; talk degrades to a calm answer rather than 502.
UI: `components/talk/TalkTo.tsx`.

## Rolling out another tab

The chat, reasoning separation, budget discipline and governed spine are shared. A tab is
just a `TALK_CONFIGS` entry: its `metadata` source (already in `metadata.ts` for all five)
and its `retrieval` strategy. `data` reuses `runAsk` (NL→SQL over governed `queryRun`);
`knowledge` reuses `retrieveKnowledge`; `files` reuses `searchFiles`. `metrics` /
`connections` ship metadata-only (the overview is the grounding) — a one-line upgrade when
a governed retrieval is wired. Only **Data** is rendered today.

## Invariants

- **Read-only.** Every retrieval path is a read; no `talk` code writes.
- **Reasoning is separate.** `TalkResult.reasoning` is the model's `reasoning_content`,
  verbatim and labelled — never concatenated into `answer`.
- **Budget is bounded.** The assembled context never exceeds `inputBudget(reasoning model)`.
- **Governed + AS-the-user.** Metadata + retrieval use the caller's visibility gate; the
  turn is OPA-consistent and Langfuse-traced.
- **Honest.** Citations are real ids the caller was entitled to; no URLs are invented; a
  no-context / failed-retrieval turn says so instead of fabricating.
