<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Knowledge — architecture & seam guide

The **Knowledge** tab is the domain's *operating manual*: human-authored Markdown
workflows + tacit notes + domain context, made retrievable by a **knowledge agent**
over a **hybrid index** (lexical + embedding) with **rerank**, all behind
**document-level security (DLS)** and OPA. Knowledge is authored Personal → promoted
Shared → certified to the Marketplace, exactly like every other artifact tier.

This document describes the shipped code, not internal design notes.

## Module map (`os-ui/lib/knowledge/`)

| Module | Role | `server-only`? |
|---|---|---|
| `schema.ts` | Pure workflow/step/rule types + parse/validate. | no |
| `chunk.ts` | Workflow/domain → retrievable `KnowledgeUnit`s with `Provenance`. | no |
| `embed-core.ts` / `embed.ts` | Deterministic offline embedding (`hashEmbed`) + cosine; live embed seam. | no / yes |
| `retrieve-core.ts` | Pure retrieval core: `canSee`/`applyDls` (DLS), `lexicalScore`, `hybridScore`, `rerank`, `Principal`. | no |
| `retrieve.ts` | Wires the core to the live OpenSearch hybrid index + reranker. | yes |
| `eval-harness.ts` | Golden-grounding + access-control eval gates (`evaluateGolden`, `evaluateAccessControl`). | no |
| `store.ts` | The workflow/domain registry: list/get/create/update/publish/certify, tier + DLS. | yes |
| `rules-edit.ts` / `step-edit.ts` | Surgical edits to a workflow's rules/steps (agent-proposable). | no |
| `context-pack.ts` | Packs retrieved units into an agent context window (attach-as-context). | no |
| `agent-scaffold.ts` | Scaffolds a domain agent from certified workflows (handover out). | no |
| `swimlane-layout.ts` | Pure layout for the workflow swimlane view. | no |

Pure modules (no `server-only`) are unit-tested directly with `node --test`.

## Cross-tab seams

| Seam | Direction | Interface | Status |
|---|---|---|---|
| **Files → Knowledge** | in | A promoted/used file is handed off as a knowledge source (`files/store` "Use as → Knowledge"). | wired (real) |
| **Knowledge → Agents** | out | `context-pack.ts` (attach-as-context) + `agent-scaffold.ts` (scaffold a domain agent from certified workflows). | wired (real) |
| **Knowledge → Marketplace** | out | Certified workflows list as `knowledge` products via the Marketplace registry. | wired (real) |
| **Knowledge → Governance** | out | A certify/publish that needs sign-off enqueues a `knowledge_certify` approval. | wired (real) |
| **Agent memory → Knowledge** | in | An approved `knowledge_certify` curates a fact into the operating manual. | wired (real) |

DLS is the invariant: every retrieval path runs through `canSee`/`applyDls`, so a
`creator`/`participant` never sees another principal's Personal units; `builder`/`admin`
see Shared units inside their own domain; Marketplace units are discoverable by all.
