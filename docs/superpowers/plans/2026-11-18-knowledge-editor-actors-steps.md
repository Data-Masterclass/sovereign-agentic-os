# Knowledge workflow editor — actors you can delete, steps that save

> Plan of record for the Knowledge-tab workflow-editor fix (2026-11-18). Written before the code,
> in the superpowers writing-plans format: goal → architecture → file list → tasks with the exact
> test code each task starts from. Test-first: every task's test is written and seen failing before
> its implementation.

## The two reports, verbatim

**Problem A (owner):** *"The whole actor editing is weird. It looks all a bit fragile and you
directly edit the name but cannot see any details for the actor."*

**Problem B (owner):** *"the steps in the workflow cannot be really edited. When you change the
expert knowledge, there is no way to save it."*

## Goal

One workflow editor where the actor registry behaves like a registry (open an actor, see it,
rename it, delete it — and the steps follow), and where a step edit is a deliberate, visible,
never-dropped save.

Done means:

1. An actor the user deletes stays deleted across a reload, and a step that still names it reports
   a **validation warning** instead of resurrecting the actor.
2. An actor has a side panel with its own details (name · category · description · the steps that
   use it) and an explicit Save — the registry row is no longer an input box.
3. A rename in the registry travels to every referencing step in the same commit.
4. Deleting an actor that is in use asks first: reassign its steps to another actor, or clear them.
5. A step's fields are a controlled form with Save, a dirty marker, an unsaved-changes guard and an
   inline error when the commit fails.
6. Two edits in a row both land — commits queue, none is dropped, and every failure is reported.
7. A multi-line expert-knowledge note survives a round trip unchanged, including a line that starts
   `---` and a line that is a code fence.

## Verified causes (read in the tree at `7c524586`)

| # | Cause | Where |
|---|---|---|
| A1 | `deriveActors()` rebuilds the registry on **every** parse as declared `actors:` merged with every distinct (category, name) on the steps. `removeActor` is therefore undone on the next load, and the actor returns **without an `id`**. | `tabs/knowledge/lib/schema.ts:233`, `:371` |
| A2 | `ActorsPanel` renders the ✕ and the editable fields only when `a.id` exists — so a resurrected actor is also un-deletable and un-editable. | `tabs/knowledge/ui/ActorsPanel.tsx` |
| A3 | Steps reference an actor by (category, name), so a registry rename does not travel; the step silently points at a name nobody declares. | `schema.ts` `WorkflowStep.actor_name` |
| A4 | The name is edited in place on the row (`defaultValue` + `onBlur`), with no detail view at all. | `ActorsPanel.tsx` |
| B1 | `mutate` returns silently when a previous commit+reload is in flight (`if (actingRef.current) return;`) and every field commits on blur — so "edit a field, then click something" drops the edit with no error. | `tabs/knowledge/ui/WorkflowView.tsx:161-178` |
| B2 | `StepInspector` fields are uncontrolled `defaultValue`, and the inspector is not keyed by step id — switching steps shows the previous step's text. | `tabs/knowledge/ui/StepInspector.tsx` |
| B3 | The tacit parser strips only the `> ` prefix per continuation line, while the serializer writes `> tacit: ` on **every** line — so a multi-line note gains literal `tacit: ` prefixes on each round trip. | `schema.ts` `parseSteps` tacit branch |
| B4 | The tacit lookahead truncates any note containing a line that starts `---` or a fence. | same |

## Architecture

### The registry is the source of truth once it exists

```
workflow.md frontmatter
  actors: [...]   present (even as [])  ->  THE registry. Parsed as-is. No derivation.
  actors:         absent (legacy file)  ->  derived from the steps' (category, name) pairs,
                                           each derived actor given a STABLE id, and written
                                           back by the next serialize.
```

Two invariants make deletion durable:

* **Every registry actor has an `id`.** Declared actors keep theirs; a declared actor without one
  and every derived actor gets `stableActorId(category, name)` — deterministic, so repeated parses
  never churn ids and a serialize → parse round trip is a fixed point.
* **`serializeWorkflow` always emits the `actors:` key**, including the empty list. That empty list
  is the signal "this workflow's registry is deliberately empty" — without it, deleting the last
  actor would hand the next parse a file with no `actors:` section and derivation would resurrect
  everything.

A step whose (category, name) is in no registry entry is **not** a missing registry entry to be
filled in; it is a workflow defect. `actorWarnings()` reports it, the inspectors show it, and the
cure is a human one: pick a registry actor for the step, or add the actor back.

### Who may change what

| Mutation | Rule |
|---|---|
| `updateActor(w, id, patch)` | A name/category change rewrites **every referencing step** in the same returned workflow — one mutation, one commit, no window where the steps disagree with the registry. |
| `removeActor(w, id, opts)` | Unused → plain delete. In use → `{ reassignTo }` moves its steps to another registry actor, or the default clears their `actor_name`. The UI must ask; the lib enforces nothing but the two shapes. |
| `setStepActorFromRegistry` | Unchanged — the only way a step acquires an actor reference. |

### The commit queue

`mutate` stops being "drop if busy" and becomes "append to a chain". The queue lives in
`tabs/knowledge/lib/commit-queue.ts` as a pure helper so it is unit-testable (tests cannot import
`.tsx`):

```
enqueue(task) -> appended to the tail promise
              -> runs after every earlier task, in order
              -> resolves {ok:true} | {ok:false,error} — never throws, never drops
              -> a failing task does not block the ones behind it
              -> onBusyChange(true/false) drives the spinner, onError the banner
```

`WorkflowView` holds one queue in a ref; `mutate` enqueues `commitWorkflow → reload` and **returns
the outcome**, so an inspector can keep its draft and show an inline error when a save fails.

### The inspectors

```
Visual flow panel : SwimlaneCanvas --select step-->  StepInspector  key={step.id}
Actors panel      : ActorsPanel    --select actor--> ActorInspector key={actor.id}
```

Both are the same vocabulary: a head with the subject's name, controlled fields, a `• unsaved`
marker, `Save` / `Revert`, an inline error, and a close that guards unsaved changes.
`ActorInspector` adds the steps that use the actor (clickable — jumps to the visual panel with that
step selected) and the delete flow. `ActorsPanel` keeps only the list and the add form; its rows
open the inspector.

### Tacit, symmetric

```
serialize : ''            -> (no blockquote)
            'a\n---\n```' -> '> tacit: a' / '> tacit: ---' / '> tacit: ```'
parse     : take the first line matching /^>\s*tacit:/ in the text after the step fence, then every
            CONSECUTIVE line that starts '>'; strip '>' + one space, then an optional 'tacit:' +
            one space; join with '\n'.
```

Line-scanning instead of one regex with a lookahead is what fixes B4: a `---` or a fence inside the
note is just another `> `-prefixed line, and the note ends where the blockquote ends.

## Non-goals

* No change to `workflow.md`'s shape beyond the always-present `actors:` key.
* No change to the swimlane renderer, Mermaid, the PDF report or the OKF bundle format.
* Links and step rules keep their immediate add/remove commits (they are actions, not text fields);
  only the text fields move behind Save.
