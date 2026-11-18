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

---

# DESIGN

## File list

| File | New? | What changes |
|---|---|---|
| `os-ui/tabs/knowledge/lib/schema.ts` | — | `stableActorId` / `withActorIds` / `resolveActorRegistry`; `parseWorkflow` uses the registry when the `actors:` key is present and derives only when it is absent; `serializeWorkflow` always emits `actors:` (empty list included); the tacit parser becomes a blockquote line scanner; the tacit serializer stops emitting a trailing space on a blank line. `deriveActors` keeps its merge semantics (the MCP authoring path wants it) but now hands back ids. |
| `os-ui/tabs/knowledge/lib/actor-registry.ts` | **new** | Pure queries over the registry: `stepsUsingActor`, `actorWarnings` (`ActorWarning = { stepId, stepTitle, actorCategory, actorName, message }`), `findActorById`, `actorLabel`. |
| `os-ui/tabs/knowledge/lib/step-edit.ts` | — | `updateActor` propagates a name/category change to every referencing step in the same returned workflow; `removeActor(w, id, opts)` gains `{ reassignTo?: string; clearSteps?: boolean }` (default: registry-only removal, which is what leaves the warning behind). |
| `os-ui/tabs/knowledge/lib/commit-queue.ts` | **new** | `createCommitQueue({ onError, onBusyChange })` → `{ enqueue, pending, busy }`. Serial, never drops, never throws, reports every failure. |
| `os-ui/tabs/knowledge/lib/okf-model.ts` | — | `okfDocToWorkflow` uses `resolveActorRegistry` so an imported bundle's registry is its registry, not a merge. |
| `os-ui/tabs/knowledge/ui/ActorInspector.tsx` | **new** | The actor side panel: name · category · description, controlled, `Save` / `Revert`, dirty marker, inline error; the steps that use the actor (clickable); the delete flow (unused → delete, in use → reassign or clear). |
| `os-ui/tabs/knowledge/ui/ActorsPanel.tsx` | — | List + add form only. Rows are buttons that open the inspector; the inline name input, the inline category select and the row ✕ are gone. Shows the per-actor step count and any unknown-actor warnings. |
| `os-ui/tabs/knowledge/ui/StepInspector.tsx` | — | Controlled draft (title · actor · inputs · outputs · expert knowledge) with `Save` / `Revert`, dirty marker, unsaved-changes guard on close, inline error; shows the step's actor warning when its actor is not in the registry. |
| `os-ui/tabs/knowledge/ui/WorkflowView.tsx` | — | One `createCommitQueue` in a ref; `mutate` enqueues and **returns** the outcome; `key={step.id}` on `StepInspector`; the actors panel gains `ActorInspector` with `key={actor.id}` and the step jump. |
| `os-ui/tabs/knowledge/lib/actor-registry.test.ts` | **new** | Resurrection, delete-with-reassign, delete-with-clear, rename propagation, derived ids, registry-not-re-derived, `stepsUsingActor`. |
| `os-ui/tabs/knowledge/lib/commit-queue.test.ts` | **new** | Queue never drops, failure reported and does not block, busy transitions. |
| `os-ui/tabs/knowledge/lib/editor-source.test.ts` | **new** | Source tripwires for the `.tsx` facts tests cannot import: inspector keying, no `defaultValue`, no `onBlur` commits, no inline name input, the queue replaced the drop-if-busy guard. |
| `os-ui/tabs/knowledge/lib/schema.test.ts` | — | The tacit round trip (three lines, one `---`, one fence) and the derived-id assertion. |

Guard rails for every task: a tab imports only `@core/*` and itself; `FEATURE` / `USER STORY` /
`ARCHITECTURE` + SPDX headers on the four new files; no TS enums, no parameter properties; tests
import no `.tsx`; `node scripts/check-structure.mjs` must not rise above 419 / 1 / 200 / 1233.

## Tasks

### Task 1 — the registry is the source of truth (A1)

`schema.ts`: `stableActorId(category, name)` = `actor-<category lowercased>-<slug(name)>`;
`withActorIds(actors)` fills a missing id; `resolveActorRegistry(steps, declared)` returns
`withActorIds(dedupe(declared))` when `declared` is an array and `withActorIds(derive(steps))` when
it is `undefined`. `parseWorkflow` passes `Array.isArray(front.actors) ? parsed : undefined`.
`serializeWorkflow` always writes `frontDoc.actors`.

Tests (`actor-registry.test.ts`, written first):

```ts
test('an actor removed from the registry stays gone after a re-parse (no resurrection)', () => {
  const w1 = removeActor(parseWorkflow(WITH_REGISTRY), 'a-officer'); // step `prepare` still names it
  const again = parseWorkflow(serializeWorkflow(w1));
  assert.equal(again.actors.find((a) => a.name === 'Loan Officer'), undefined);
  assert.deepEqual(
    actorWarnings(again).map((x) => [x.stepId, x.actorName]),
    [['prepare', 'Loan Officer']],
  );
});

test('removing the LAST registry actor survives the round trip (an empty actors: is written)', () => {
  let w = parseWorkflow(WITH_REGISTRY);
  for (const a of [...w.actors]) w = removeActor(w, a.id!);
  const again = parseWorkflow(serializeWorkflow(w));
  assert.deepEqual(again.actors, []);
  assert.equal(actorWarnings(again).length, 2);
});

test('a legacy workflow with no actors: section derives a registry, each with a stable id', () => {
  const w = parseWorkflow(LEGACY_NO_REGISTRY);
  assert.equal(w.actors.length, 2);
  assert.ok(w.actors.every((a) => !!a.id), 'every derived actor carries an id');
  const again = parseWorkflow(serializeWorkflow(w));
  assert.deepEqual(again.actors.map((a) => a.id), w.actors.map((a) => a.id));
  assert.equal(actorWarnings(again).length, 0);
});

test('with an actors: section the registry is NOT re-derived from the steps', () => {
  const w = parseWorkflow(REGISTRY_MISSING_ONE);
  assert.deepEqual(w.actors.map((a) => a.name), ['Loan Officer']);
  assert.deepEqual(actorWarnings(w).map((x) => x.actorName), ['BankPortal']);
});
```

### Task 2 — rename travels, delete asks (A3, A4)

`step-edit.ts`: `updateActor` records the actor's old (category, name), applies the patch, then
rewrites every step that matched the old pair. `removeActor(w, id, { reassignTo })` points the
referencing steps at that registry actor; `{ clearSteps: true }` empties their `actor_name`.

```ts
test('renaming a registry actor rewrites every referencing step in the same mutation', () => {
  const w = updateActor(parseWorkflow(WITH_REGISTRY), 'a-officer', { name: 'Senior Loan Officer' });
  assert.equal(w.steps[0].actor_name, 'Senior Loan Officer');
  assert.equal(actorWarnings(w).length, 0);
  const again = parseWorkflow(serializeWorkflow(w));
  assert.equal(again.steps[0].actor_name, 'Senior Loan Officer');
  assert.ok(again.actors.find((a) => a.name === 'Senior Loan Officer'));
});

test('changing a registry actor category moves its steps to the new category', () => {
  const w = updateActor(parseWorkflow(WITH_REGISTRY), 'a-officer', { category: 'Agent' });
  assert.equal(w.steps[0].actor, 'Agent');
  assert.equal(actorWarnings(w).length, 0);
});

test('removeActor with reassignTo moves every referencing step to the other actor', () => {
  const w = removeActor(parseWorkflow(WITH_REGISTRY), 'a-officer', { reassignTo: 'a-portal' });
  assert.equal(w.actors.length, 1);
  assert.equal(w.steps[0].actor, 'Software');
  assert.equal(w.steps[0].actor_name, 'BankPortal');
  assert.equal(actorWarnings(w).length, 0);
});

test('removeActor with clearSteps leaves no dangling name and no warning', () => {
  const w = removeActor(parseWorkflow(WITH_REGISTRY), 'a-officer', { clearSteps: true });
  assert.equal(w.steps[0].actor_name, '');
  assert.equal(actorWarnings(w).length, 0);
});

test('stepsUsingActor lists the steps an actor is used by', () => {
  const w = parseWorkflow(WITH_REGISTRY);
  assert.deepEqual(stepsUsingActor(w, w.actors[0]).map((s) => s.id), ['prepare']);
});
```

### Task 3 — the commit queue (B1)

`commit-queue.ts` as described. Tests (`commit-queue.test.ts`):

```ts
test('a commit enqueued while another is in flight is queued, never dropped', async () => {
  const order: string[] = [];
  const first = deferred();
  const q = createCommitQueue();
  const a = q.enqueue(async () => { order.push('a:start'); await first.promise; order.push('a:end'); });
  const b = q.enqueue(async () => { order.push('b'); });
  const c = q.enqueue(async () => { order.push('c'); });
  assert.equal(q.pending, 3);
  first.resolve();
  assert.deepEqual(await Promise.all([a, b, c]), [{ ok: true }, { ok: true }, { ok: true }]);
  assert.deepEqual(order, ['a:start', 'a:end', 'b', 'c']);
  assert.equal(q.pending, 0);
});

test('a failing commit is reported and does not block the ones behind it', async () => {
  const errors: string[] = [];
  const q = createCommitQueue({ onError: (m) => errors.push(m) });
  const bad = q.enqueue(async () => { throw new Error('409 stale sha'); });
  const good = q.enqueue(async () => { /* must still run */ });
  assert.deepEqual(await bad, { ok: false, error: '409 stale sha' });
  assert.deepEqual(await good, { ok: true });
  assert.deepEqual(errors, ['409 stale sha']);
});

test('busy flips true while work is in flight and false when the queue drains', async () => {
  const busy: boolean[] = [];
  const q = createCommitQueue({ onBusyChange: (b) => busy.push(b) });
  await q.enqueue(async () => {});
  await q.enqueue(async () => {});
  assert.deepEqual(busy, [true, false, true, false]);
});
```

### Task 4 — tacit, symmetric (B3, B4)

`schema.ts`: replace the tacit regex with a line scan over the post-fence text. Test in
`schema.test.ts`:

```ts
const MULTILINE_TACIT = [
  'Check section 4 — the date field is frequently missed.',
  '--- escalate to the desk head ---',
  '```',
].join('\n');

test('tacit: a three-line note with a --- line and a fence line round-trips unchanged', () => {
  const w = parseWorkflow(VALID_WORKFLOW);
  w.steps[0].tacit = MULTILINE_TACIT;
  const once = parseWorkflow(serializeWorkflow(w));
  assert.equal(once.steps[0].tacit, MULTILINE_TACIT);
  const twice = parseWorkflow(serializeWorkflow(once));
  assert.equal(twice.steps[0].tacit, MULTILINE_TACIT, 'a second round trip must not add `tacit: ` prefixes');
  assert.equal(twice.steps[1].tacit, '');
});
```

The existing `okf-model.test.ts` round trip and `okf-roundtrip.test.ts` must stay green — they are
the regression net for the serializer change.

### Task 5 — the two inspectors (A2, A4, B2)

`ActorInspector.tsx` (new) and the rewrites of `ActorsPanel.tsx`, `StepInspector.tsx`,
`WorkflowView.tsx`. Tests are source tripwires (`editor-source.test.ts`), because a test cannot
import a `.tsx`:

```ts
test('StepInspector is keyed by step id so switching steps cannot show stale text', () => {
  assert.match(read('tabs/knowledge/ui/WorkflowView.tsx'), /<StepInspector[\s\S]{0,400}key=\{step\.id\}/);
});

test('ActorInspector is keyed by actor id', () => {
  assert.match(read('tabs/knowledge/ui/WorkflowView.tsx'), /<ActorInspector[\s\S]{0,400}key=\{actor\.id/);
});

test('StepInspector has no uncontrolled defaultValue field left', () => {
  assert.ok(!read('tabs/knowledge/ui/StepInspector.tsx').includes('defaultValue'));
});

test('no StepInspector or ActorInspector field commits on blur — a Save button does', () => {
  for (const f of ['tabs/knowledge/ui/StepInspector.tsx', 'tabs/knowledge/ui/ActorInspector.tsx']) {
    const src = read(f);
    assert.ok(!src.includes('onBlur='), `${f} must not commit on blur`);
    assert.match(src, /Save<\/button>/);
  }
});

test('ActorsPanel no longer edits the name inline — a row opens the inspector', () => {
  const src = read('tabs/knowledge/ui/ActorsPanel.tsx');
  assert.ok(!src.includes('ap-name-input'), 'the inline name input must be gone');
  assert.ok(!src.includes('defaultValue'));
  assert.match(src, /onSelect/);
});

test('WorkflowView commits through the never-dropping queue, not the drop-if-busy guard', () => {
  const src = read('tabs/knowledge/ui/WorkflowView.tsx');
  assert.match(src, /createCommitQueue/);
  assert.ok(!src.includes('if (actingRef.current) return;'), 'the drop-if-busy guard must be gone');
});
```

### Task 6 — the gate

`npm --prefix os-ui test`, `bash os-ui/scripts/gate.sh`, `node scripts/check-structure.mjs`,
`os-ui/node_modules/.bin/tsc --noEmit -p os-ui`. All green, structure counts not above
419 / 1 / 200 / 1233.
