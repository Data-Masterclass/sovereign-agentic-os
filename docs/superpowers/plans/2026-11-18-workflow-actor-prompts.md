# Workflow steps become the long prompts of Agent actors

> Plan of record (2026-11-18) for `feat/workflow-actor-prompts`, written before the code in the
> superpowers writing-plans format: goal → architecture → file list → tasks, each task with the
> exact test it starts from. Test-first: every task's test is written and seen failing first.
>
> **Base branch:** this plan is built on `public/fix/knowledge-editor-actors-steps` (PR #55, not
> yet merged at the time of writing), because it depends on that branch's registry-is-source-of-truth
> schema, its `actor-registry.ts` queries and its `ActorInspector`. Every change here is ADDITIVE to
> those files, so the branch rebases onto `main` cleanly once #55 lands.

## The owner's words

> *"The steps in the workflow designer should be able to be used to write the long agent prompts for
> actors that are agents and are used by the agent system that is created from them."*

## Goal

An **Agent actor is the unit of agency**, not a step. The author writes that actor's long prompt once
in the workflow designer; the steps the actor is assigned to are compiled into the rest of its
`AGENT.md`; and the agent system scaffolded from the workflow creates **one agent per Agent actor**,
carrying exactly that file.

Done means:

1. An actor of category `Agent` carries an optional long `prompt` (markdown, multi-line) in the
   workflow frontmatter `actors:` entry, and a `parse → serialize → parse` round trip is a fixed
   point — including a prompt that contains a `---` line, a fence, and blank lines.
2. The scaffold emits **one agent per Agent actor** (not per step), whose `AGENT.md` is the actor's
   prompt verbatim first, then a generated section *"Your steps in the &lt;workflow&gt; workflow"*
   listing, in workflow order, every step assigned to that actor — title, inputs, outputs, links,
   the step's expert-knowledge (`tacit`) note, the step's hard rules — then the workflow-level hard
   rules.
3. A step assigned to a **Human** actor keeps today's per-step disposition: `augment` → a helper
   agent, `automate` → an agent, `manual` → a human handoff. Software / Customer / Partner steps
   default to manual.
4. The supervisor/coordinator logic is unchanged: 0 agents → a coordinator, 1 → it is the entrypoint,
   ≥2 → a supervisor with sequential handoffs in workflow order.
5. In the `ActorInspector`, an Agent actor shows a **Prompt** textarea (controlled, saved by the one
   Save button, part of the dirty marker and the unsaved-changes guard) and a **read-only live
   preview** of the `AGENT.md` the scaffold would generate.
6. The preview is the scaffold's own output: the same pure function builds both, and a test asserts
   they are equal **byte-for-byte** for the same workflow.
7. The Agents tab's schema does not change; the scaffolded `system.yaml` still parses as a valid
   `System`.

Not in scope: a "Regenerate agent system" action (the existing handoff simply gets the new content),
any change to the Agents tab's own editors, and any change to how a run executes.

## What exists today (read at `490a65f5`)

| Where | Today |
|---|---|
| `tabs/knowledge/lib/schema.ts` | `Actor = {id?, name, category, description?}`. `actors:` is the source of truth once present (PR #55); `stableActorId` makes a derived id deterministic. |
| `tabs/knowledge/lib/agent-scaffold.ts` | One agent **per step** whose disposition is `augment`/`automate`. `stepAgentMd()` writes a short generated AGENT.md per step. The actor registry is **not consulted at all**. |
| `tabs/knowledge/lib/actor-registry.ts` | `actorForStep`, `stepsUsingActor`, `findActorById`, `actorLabel`, `actorWarnings` — the pure "who uses this actor" answers both inspectors share. |
| `tabs/knowledge/ui/ActorInspector.tsx` | Name · category · description, one Save, a dirty marker, the delete flow. No prompt, no preview. |
| `app/api/knowledge/workflows/[id]/scaffold-agent/route.ts` | POST → `scaffoldSystem(workflow, {dispositions})`; `create:true` materialises it through `tabs/agents/lib/store`. |
| `tabs/knowledge/ui/HandoverPanel.tsx` | The per-step disposition toggles and the "Create agent system (N agents)" button — N counts **steps**, which will now be wrong. |

## Architecture

### The model: a prompt on the registry entry

```
workflow.md frontmatter
  actors:
    - id: actor-agent-triage-bot
      name: Triage Bot
      category: Agent
      description: Triages inbound submissions.
      prompt: |-            # ← new, optional, multi-line, markdown
        # Triage Bot
        You are the triage desk for inbound submissions…
```

Three decisions, each with a reason:

* **The parser and serializer carry `prompt` for an actor of ANY category, not only `Agent`.** The
  editor offers the field only for an Agent actor and the scaffold only consumes it for one, but a
  model that dropped the prompt when the category changed would silently destroy the author's work
  on a mis-click. Lossless in, lossless out; the UI decides what is *offered*.
* **`prompt` is trimmed on parse and the trimmed value is written on serialize**, so the round trip
  is a fixed point rather than a file that grows a newline per save.
* **The prompt is NOT a step field.** A step is work; an actor is the agent. Putting the prompt on
  the step would mean a 6-step actor had six prompts and no identity.

### The scaffold: one agent per Agent actor

```
workflow steps ──┬─ actor.category = Agent, step in the registry ──→ grouped into THAT ACTOR's agent
                 │      (default disposition automate; an explicit `manual` excludes the step)
                 ├─ actor.category = Agent, actor NOT in the registry (or no actor name)
                 │                                                 ──→ a per-STEP agent (today's shape)
                 ├─ any other category, disposition augment|automate ──→ a per-STEP agent (today's shape)
                 └─ anything else                                   ──→ a manual handoff
```

An Agent actor becomes an agent when **at least one** of its steps is not `manual`. The actor's
`AGENT.md`, however, is a pure function of `(workflow, actor)` — it lists **every** step assigned to
that actor, regardless of disposition. That is deliberate: it is what makes the editor's preview
equal the scaffold's output byte-for-byte without the editor having to guess the dispositions the
author will pick later in the handover panel. Dispositions decide *whether* an agent exists; they do
not rewrite *what it is told*.

The fallback for an Agent step whose actor is not in the registry matters: `actorWarnings()` already
reports that defect, and the scaffold must not lose the step while the author fixes it.

### The agent's id

`agentIdForActor(actor)` slugs the actor's **name** (`"Triage Bot"` → `triage-bot`), prefixes it to
start with a letter, and falls back to the actor's id slug when the name slugs to nothing. Ids are
de-duplicated across the whole plan (`-2`, `-3`) so an actor named like a step cannot collide. The
id is deterministic, because it ends up in `system.yaml` edges and a churning id would rewrite the
graph on every scaffold.

### Where the AGENT.md builder lives, and why not in `agent-scaffold.ts`

`agent-scaffold.ts` imports `@tabs/agents/lib/system-schema` — the one pre-existing cross-tab import
on this path, baselined in the `TAB-ISOLATION` ratchet (419). The editor must not add a second one,
and a **client component must not pull the Agents tab's schema into the browser bundle** to render a
preview. So the pure, dependency-light half moves to a new module:

```
tabs/knowledge/lib/actor-prompt.ts        imports: this tab's schema + actor-registry. Nothing else.
  Disposition, defaultDisposition         (moved here; agent-scaffold re-exports both, so every
                                           existing importer — the route, HandoverPanel — is unchanged)
  agentIdForActor(actor)
  actorAgentMd(workflow, actor)           the AGENT.md, prompt first then the generated section
  planAgents(workflow, dispositions)      { actorAgents, stepAgents, manualSteps } — the grouping

tabs/knowledge/lib/agent-scaffold.ts      keeps the System/yaml half, now built from planAgents()
tabs/knowledge/ui/ActorInspector.tsx      imports actorAgentMd ONLY — same tab, no agents import
```

So the tab-isolation count cannot grow, and "the preview is the scaffold's output" is a fact of
construction rather than a convention someone has to maintain.

### The generated AGENT.md, exactly

```markdown
<actor.prompt, verbatim>            ← when the actor has one; otherwise a 3-line generated stand-in:
                                       "# <name>" / "" / "You are <name>, an agent in the "<title>" workflow." (+ description)

## Your steps in the <workflow title> workflow

### 1. <step title>
- Inputs: a, b                      ← omitted when empty
- Outputs: c                        ← omitted when empty
- Linked entities: data:Customer Applications
- Expert knowledge: <tacit, one line per note line, indented as a markdown continuation>
- HARD RULE: <step hard rule>       ← step rules + workflow rules scoped to this step
                                       (soft rules are deliberately NOT in the prompt: they are
                                        guidance for a human, and the agent's hard rules must stay
                                        unambiguous)

### 2. …

## Hard rules for the whole <workflow title> workflow
- <workflow-level hard rule>

Use the granted, governed `retrieve` tool to pull this workflow's steps, expert-knowledge notes and
rules as needed.
```

A step section is rendered even when the step has nothing but a title: "you own this step" is itself
the instruction.

### What does not change

* `system.yaml` shape, `parseSystem`, `commit_agent_files`, the worker, the Agents tab UI.
* The per-step path for Human/Software/Customer/Partner dispositions, including `stepAgentMd`.
* The supervisor / single-agent / coordinator branches, and `grants.knowledge` attaching the whole
  workflow.
* `okf-model.ts`'s body rendering — only the lossless extension block learns `prompt`.

## File list

| File | Change |
|---|---|
| `os-ui/tabs/knowledge/lib/schema.ts` | `Actor.prompt?: string`; `parseActor` reads it; `serializeWorkflow` writes it when non-empty. Additive. |
| `os-ui/tabs/knowledge/lib/schema.test.ts` | NEW tests: prompt round trip (fixed point, `---`/fence/blank lines), prompt survives on a non-Agent actor. |
| `os-ui/tabs/knowledge/lib/actor-prompt.ts` | **NEW.** `Disposition`, `defaultDisposition`, `agentIdForActor`, `actorAgentMd`, `planAgents`. |
| `os-ui/tabs/knowledge/lib/actor-prompt.test.ts` | **NEW.** The AGENT.md contract and the grouping contract. |
| `os-ui/tabs/knowledge/lib/agent-scaffold.ts` | Build the agents from `planAgents()`; re-export `Disposition`/`defaultDisposition`. |
| `os-ui/tabs/knowledge/lib/agent-scaffold.test.ts` | Rewritten expectations: one agent per Agent actor; a Human step with `automate` still becomes an agent; the yaml still parses. |
| `os-ui/tabs/knowledge/lib/step-edit.ts` | `addActor` accepts `prompt`; `updateActor`'s patch accepts `prompt` (empty string deletes the key). |
| `os-ui/tabs/knowledge/lib/step-edit.test.ts` | NEW tests for both. |
| `os-ui/tabs/knowledge/lib/okf-model.ts` | `coerceActor` keeps `prompt`, so an OKF export → import round trip does not lose it. |
| `os-ui/tabs/knowledge/lib/okf-model.test.ts` | NEW test: the prompt survives `workflowToOkfDoc` → `okfDocToWorkflow`. |
| `os-ui/tabs/knowledge/ui/ActorInspector.tsx` | Prompt textarea (Agent actors only) + the read-only `AGENT.md` preview. |
| `os-ui/tabs/knowledge/ui/HandoverPanel.tsx` | The button's agent count comes from `planAgents`, not from counting steps. |
| `os-ui/tabs/knowledge/lib/editor-source.test.ts` | Additive tripwires: the inspector's prompt field is controlled, and the preview calls `actorAgentMd`. |
| `os-ui/core/mcp/write-common.ts` | `mapActors` carries `prompt`, so the MCP authoring twin can write one. |
| `os-ui/ARCHITECTURE.md` | A short section: the actor is the unit of agency; why the builder is not in `agent-scaffold.ts`. |

## Tasks (test-first, in order)

1. **The model.** `Actor.prompt` + parse/serialize + the round-trip tests.
2. **The AGENT.md builder.** `actor-prompt.ts` with `actorAgentMd` and its tests.
3. **The grouping.** `planAgents` + its tests (Agent actor groups its steps; unknown actor falls
   back to a step agent; a Human `automate` step is a step agent; `manual` is excluded).
4. **The scaffold.** `agent-scaffold.ts` rebuilt on `planAgents`; byte-for-byte test against
   `actorAgentMd`; `parseSystem` still accepts the yaml.
5. **The mutations.** `addActor` / `updateActor` prompt support + tests.
6. **The editor.** The textarea and the preview in `ActorInspector`, the handover count, the source
   tripwires.
7. **Lossless export.** `okf-model.ts` `coerceActor` + test.
8. **Gates.** Full unit suite, `scripts/gate.sh`, `node scripts/check-structure.mjs`
   (≤ 419 / 1 / 200 / 1231), `os-ui/node_modules/.bin/tsc --noEmit -p os-ui`.

## Risks

| Risk | Mitigation |
|---|---|
| A rebase onto a merged #55 conflicts. | Every touched #55 file (`ActorInspector.tsx`, `editor-source.test.ts`, `schema.ts`) is only ever APPENDED to or extended; no line of its logic is rewritten. |
| The preview drifts from the scaffold. | One function builds both, plus a test asserting equality byte-for-byte, plus a source tripwire that the component calls it. |
| `yaml.dump` mangles a multi-line prompt. | The round-trip test is a fixed point over a prompt containing a `---` line, a fence and a blank line, run twice. |
| An actor-derived agent id collides with a step-derived one. | One de-duplication pass over the whole plan, tested. |
| The browser bundle grows an Agents-tab import. | The preview imports `actor-prompt.ts`, which imports nothing but this tab's schema and registry. |
