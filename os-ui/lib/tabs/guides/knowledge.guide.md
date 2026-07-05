# Knowledge — golden path

## What this is

The Knowledge tab is the OS's canonical store for how work gets done. It holds three asset types: **steps** (ordered sequences with Human, Software, or Agent actors), **rules** (guardrails with hard enforcement flags), and **tacit** (unstructured know-how that resists formalization). Knowledge grounds agents — an agent system without published knowledge is operating blind. In the cross-tab spine, knowledge feeds directly into the Agents tab.

## How to build it

1. **Dedupe first.** Call `search_knowledge` with the concept you plan to capture. If a relevant article exists, call `get_knowledge` and extend it rather than authoring a duplicate. Call `list_knowledge` to browse by type or domain.
2. **Author.** Call `author_knowledge` with `type` (steps | rules | tacit), `title`, `body`, and `domain`. For steps, include an `actors` array — each step declares whether the actor is Human, Software, or Agent. For rules, set `hard: true` on any rule that must not be violated. Tacit entries have no required structure beyond a body.
3. **Index.** Call `index_knowledge` to chunk, embed, and make the article retrievable via semantic search. This step is required before the article appears in `search_knowledge` results.
4. **Verify.** Call `search_knowledge` with a phrase drawn from the article body. Confirm the article surfaces in the top results. This closes the authoring loop.
5. ⛔ **Builder publishes.** A Builder or Admin calls `publish_knowledge` to move the article from Personal to Shared. Published articles are visible to domain members and can be referenced by agent systems.

**Note:** `search_knowledge` hits carry provenance metadata (author, domain, tier). Always cite the source when you relay knowledge to a user.

## What to consider

- **Search before authoring.** Duplicate knowledge fragments the canonical record. A `search_knowledge` call with a broad query is cheap; a duplicate article is expensive to reconcile later.
- **Actor fidelity matters.** Steps with incorrect actor types (e.g. marking an automated step as Human) mislead agents that consume the knowledge.
- **Index is not automatic.** `author_knowledge` creates a draft record; `index_knowledge` makes it findable. Missing this step means agents will not retrieve the article.
- **Hard rules are enforced.** When an agent system ingests published knowledge, `hard: true` rules are applied as constraints. Set this flag deliberately.
- **Provenance must be cited.** Do not paraphrase or strip attribution from knowledge hits. The OS traces which knowledge grounded which agent action.

## Governance

| Step | Role required |
|---|---|
| `search_knowledge`, `list_knowledge`, `get_knowledge` | Creator |
| `author_knowledge`, `index_knowledge` | Creator (own work) |
| ⛔ `publish_knowledge` | Builder or Admin |

OPA enforces domain scope. Unpublished articles are Personal and invisible to agents. A creator cannot publish their own knowledge — file the article and hand off to a Builder.

**Worked example:**

```
search_knowledge({ query: "how to reconcile invoice exceptions", domain: "finance" })
→ [] — no existing article

author_knowledge({ type: "steps", title: "Invoice exception reconciliation",
  body: "1. Pull flagged invoices...", actors: ["Human","Software"], domain: "finance" })
→ { id: "kn_04F...", state: "draft" }

index_knowledge({ id: "kn_04F..." })
→ { indexed: true, chunkCount: 4 }

search_knowledge({ query: "reconcile invoice exceptions" })
→ [{ id: "kn_04F...", score: 0.94, provenance: { author: "alex@..." } }]
```

A Builder then calls `publish_knowledge({ id: "kn_04F..." })` to make it available to agents.
