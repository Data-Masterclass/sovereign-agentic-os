# Knowledge — golden path

## What this is

The Knowledge tab is the OS's canonical store for how work gets done. A
workflow holds three kinds of content that complement each other:

- **steps** — ordered sequence of actions, each owned by a Human, Software, or
  Agent actor, with inputs, outputs, and an optional per-step inline tacit note.
- **rules** — guardrails (`hard: true` = must-not-violate; `hard: false` = soft
  guideline). Both workflow-level and step-level rules are supported.
- **tacit** — unstructured know-how that resists formalization: the gotchas, the
  "why behind the why", institutional memory, cultural nuances. Tacit lives in two
  places: a short **per-step** note (`steps[].tacit`) and a longer **workflow-level**
  `tacit` string (the sibling TACIT.md). Both are indexed as separate retrieval units.

Knowledge grounds agents — an agent system without published knowledge is
operating blind. In the cross-tab spine, knowledge feeds directly into the Agents
tab.

## How to build it

1. **Dedupe first.** Call `search_knowledge` with the concept you plan to capture.
   If a relevant workflow exists, call `get_knowledge` and extend it rather than
   authoring a duplicate. Call `list_knowledge` to browse by domain.

2. **Author.** Call `author_knowledge` with the real params (see below). The tool
   creates a Personal draft — a single `workflow.md` in the governed store.

3. **Index.** Call `index_knowledge` to chunk, embed, and make the workflow
   retrievable via semantic search. This step is required before the workflow
   appears in `search_knowledge` results.

4. **Verify.** Call `search_knowledge` with a phrase drawn from the workflow body
   or its tacit content. Confirm it surfaces in the top results. This closes the
   authoring loop.

5. ⛔ **Builder publishes.** A Builder or Admin calls `publish_knowledge` to move
   the workflow from Personal to Shared. Published workflows are visible to domain
   members and can be referenced by agent systems.

**Note:** `search_knowledge` hits carry provenance metadata (author, domain, tier).
Always cite the source when you relay knowledge to a user.

## `author_knowledge` — real params

```
author_knowledge({
  title:    string,          // required — e.g. "Refund handling"
  domain:   string?,         // one of your domains; defaults to your first
  markdown: string?,         // optional free prose body (context, background)
  steps: [                   // ordered steps
    {
      title:      string,    // required
      actor:      "Human" | "Software" | "Agent",
      actor_name: string?,   // e.g. "Loan Officer"
      inputs:     string[],  // artefacts consumed
      outputs:    string[],  // artefacts produced
      tacit:      string?,   // per-step inline note — gotchas, edge cases,
                             // undocumented nuances for THIS step
    }
  ],
  rules: [                   // workflow-level decision rules
    { text: string, hard: boolean }
  ],
  tacit: string?,            // workflow-level tacit doc — unstructured know-how
                             // that applies to the whole workflow (gotchas, cultural
                             // notes, the "why"). Markdown headings split it into
                             // separately-retrievable chunks. Per-step notes go in
                             // steps[].tacit instead.
})
```

### How tacit knowledge is stored and indexed

- **`steps[].tacit`** — stored as a `> tacit:` blockquote in `workflow.md`
  immediately after the step's fenced block. Chunked as a `tacit` unit with the
  step's provenance (actor, step_id). Trust = visibility − 0.05; authority = 0.5.
- **`tacit` (workflow-level)** — stored as a sibling `TACIT.md`. Markdown headings
  split it into separately-retrievable chunks so large tacit docs don't collapse
  into a single opaque blob. Trust = visibility − 0.05; authority = 0.55.
- Both are indexed by `index_knowledge` and surface in `search_knowledge` results
  with `type: "tacit"` provenance.

## What to consider

- **Search before authoring.** Duplicate knowledge fragments the canonical record.
  A `search_knowledge` call with a broad query is cheap; a duplicate article is
  expensive to reconcile later.
- **Actor fidelity matters.** Steps with incorrect actor types (e.g. marking an
  automated step as Human) mislead agents that consume the knowledge.
- **Index is not automatic.** `author_knowledge` creates a draft record;
  `index_knowledge` makes it findable. Missing this step means agents will not
  retrieve the workflow.
- **Hard rules are enforced.** When an agent system ingests published knowledge,
  `hard: true` rules are applied as constraints. Set this flag deliberately.
- **Tacit is a first-class citizen, not a hack.** Use `steps[].tacit` for inline
  per-step notes. Use the top-level `tacit` string for workflow-wide gotchas.
  Never hand-embed `> tacit:` blockquotes in the raw `markdown` param — use the
  structured fields so the chunker can index them properly.
- **Provenance must be cited.** Do not paraphrase or strip attribution from
  knowledge hits. The OS traces which knowledge grounded which agent action.

## Governance

| Step | Role required |
|---|---|
| `search_knowledge`, `list_knowledge`, `get_knowledge` | Creator |
| `author_knowledge`, `index_knowledge` | Creator (own work) |
| `retire_knowledge` (archive/delete) | Creator (own Personal); Builder+ for a Shared workflow |
| ⛔ `publish_knowledge` | Builder or Admin |

`retire_knowledge` is lineage-aware: retiring a workflow still consumed by an App
or Agent system is blocked (409) — remove those uses first. `action: "delete"` is
physical + irreversible (purges the index) and refuses a still-published workflow;
`action: "archive"` (default) is a reversible soft-hide.

OPA enforces domain scope. Unpublished workflows are Personal and invisible to
agents. A creator cannot publish their own knowledge — file the workflow and hand
off to a Builder.

**Worked example (with tacit):**

```
search_knowledge({ query: "how to reconcile invoice exceptions", domain: "finance" })
→ [] — no existing workflow

author_knowledge({
  title: "Invoice exception reconciliation",
  domain: "finance",
  steps: [
    {
      title: "Pull flagged invoices",
      actor: "Software",
      outputs: ["Flagged invoice list"],
      tacit: "The ERP export misses invoices created before 9 AM on the same day — run it after 10 AM."
    },
    {
      title: "Review and resolve",
      actor: "Human",
      inputs: ["Flagged invoice list"],
      actor_name: "Finance Analyst"
    }
  ],
  rules: [{ text: "Exceptions > 10 000 EUR need CFO sign-off", hard: true }],
  tacit: "## Seasonal note\nVolume spikes 3× in December — request extra headcount by Nov 15.\n\n## System quirk\nThe ERP auto-closes exceptions older than 90 days without notification."
})
→ { id: "wf_04F...", status: "draft", visibility: "Personal" }

index_knowledge({ workflowId: "wf_04F..." })
→ { workflow: { unitCount: 6 }, domain: { unitCount: 1 } }

search_knowledge({ query: "reconcile invoice exceptions" })
→ [{ id: "wf_04F...", score: 0.94, provenance: { type: "workflow", author: "alex@..." } },
   { id: "wf_04F...:tacit:doc:0", score: 0.87, provenance: { type: "tacit" } }]
```

A Builder then calls `publish_knowledge({ workflowId: "wf_04F..." })` to make it
available to agents.
