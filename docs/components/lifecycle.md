# Lifecycle — Studio → Test → Run

> **Two orthogonal axes.** **Audience** is My → Domain → Company: *who may use this as an
> official artefact*, changed only by promotion, with its roles, requests and approvals.
> **Lifecycle** is Draft → Testing → Live, attached to **a version**: *is this version being
> built, being tried out, or being run*. They do not interact. **A `My` object can be Live, and a
> `Company` object can have a Draft.**

Mixing the two would mean you cannot run your own thing without publishing it to your colleagues,
and cannot publish something without declaring it finished. So each object carries both, and
nothing derives one from the other — `core/kernel/object-lifecycle.test.ts` has a tripwire that
fails if a derivation ever slips in.

## The six words, and nowhere else to look

| Axis | Words | Changed by | Means |
|---|---|---|---|
| Lifecycle | **Draft · Testing · Live** | `go_live` / `retire` (or the Go live button) | which version runs |
| Audience | **My · Domain · Company** | the existing promotion path | who may use it officially |

Those are all the words there are. The UI never says "environment", "stage" or "staging";
"release" appears only for a software app's SemVer release tag, which is the tool's own noun.

## The pin — what "Live" actually is

An object's lifecycle is `{ draft: <head>, testing?: <ref>, live?: <ref> }`.

- **`draft`** is the head: what you edit. Always present.
- **`testing`** is a ref being tried out from Studio **right now**. It is not a managed state —
  there is nothing to administer, nothing to approve and nothing stored for it beyond an in-flight
  marker. "Testing" means *run, build or preview the draft from Studio*, using each kind's
  existing verify path (`verify_software`, `run_quality_checks`, `run_agent_system`,
  `preview_metric`). There is deliberately **no `run_tests` tool**.
- **`live`** is the **pin**. `go_live(kind, id, sha?)` records it; everything that *operates*
  reads it. **Editing a live object writes a new draft and does not move the pin.** `retire`
  unpins and deletes nothing.

That is the property an IT department asks about first: **what is running is a specific,
nameable, reproducible version, not "whatever the head happens to be"**.

### Where the pin is recorded

Two places, and both are readable:

1. **`os/lifecycle/pins.yml`** in the domain's git repo — committed, so an engineer's clone can
   read exactly what is live without any write access. It is **OS-owned and not pushable**: the
   receive gate rejects a change to it with *"managed by the OS; change it in the UI or over the
   MCP"*.
2. A durable pin index (`os-lifecycle-pins`), which is the operative copy the running OS reads.

**And the file is read BACK, not just written.** If the durable index is unreachable — or answers
but knows no pins, which is what a rebuilt index looks like — the OS hydrates from the committed
`os/lifecycle/pins.yml` in every domain repo. Git is the system of record; the index is a cache.

**No pin is ever written on the strength of an index nobody could read.** `go_live`, `retire` and
the migration all refuse with a `503` unless a source actually ANSWERED. An empty index from a
dead mirror is indistinguishable from a tenant with nothing live, and committing a pin file
rendered from it would silently un-live everything — the September-2026 failure in a new place. A
readable repo root with no repositories *is* an answer (a fresh tenant owns nothing) and is
writable; a repo root that is not there is not.

```yaml
# os/lifecycle/pins.yml
version: 1
domain: sales
live:
  - kind: agent
    id: sys_19b4
    ref: 9f2c1ab0c4e5d6f70819a2b3c4d5e6f708192a3b
    tag: live/agent/sys_19b4
    at: "2026-11-14T02:10:04.118Z"
    by: u_alex
```

> **Not true yet.** The **git tag** half of the pin (`live/<kind>/<id>`) is not written: it needs
> the annotated-tag API in `core/infra/git-store.ts`, which landed in a different stream. The
> `tag` column above is the name the pin *will* carry, and `go_live` reports
> `tag.written: false` rather than claiming a tag exists. The flat filename `os/lifecycle.yml`
> is likewise not what ships: see "Deviations" below.

## The per-kind Studio / Test / Run mapping

| Kind | Studio (the draft) | Test (trying the draft out) | Run (the pin) | Pinned ref is |
|---|---|---|---|---|
| **Agent system** | edit `system.yaml`; run it by hand from Studio, no schedule | `run_agent_system` on the head, from Studio | **the schedule runs the pinned `system.yaml`**, read from the repo at the live sha | a commit sha |
| **Dashboard** | edit panels; every save is a new draft | open the draft in View | **Run renders the pinned spec** — editing changes nothing until `go_live` | a spec digest (`spec:<12 hex>`) |
| **Metric** | define/edit the dbt metric | `preview_metric` on the draft | consumers resolve the pinned definition | a commit sha `[later]` |
| **Dataset** | edit the dbt model | `run_quality_checks`; build into the author's lane | Dagster schedules generated for live pins only `[later]` | a commit sha `[later]` |
| **Software app** | edit the app source | preview URL | prod URL serves the pinned release `[later]` | the SemVer release tag |
| **Knowledge workflow** | author and edit | index and search the draft | the published version | a commit sha `[later]` |
| **Connection** | configure and test | `test_connection` | the pinned configuration | a commit sha `[later]` |

### Which kinds can go live today — plainly

**All seven can hold a pin.** `go_live` and `retire` work for `dataset`, `metric`, `dashboard`,
`agent`, `app`, `knowledge` and `connection`, and each one's audience and permission gate is its
own tab's. That matters beyond tidiness: the go-live guard names a dependency that is not live, so
if a kind could not hold a pin the refusal would be impossible to clear.

**Two of the seven have their pin HONOURED** — i.e. something actually reads it to decide what to
operate:

| Kind | Can go live | Pin is honoured by |
|---|---|---|
| **agent** | yes | **the schedule**: a scheduled run reads the pinned `system.yaml` at the live sha |
| **dashboard** | yes | **the Run view**: `?surface=run` renders the pinned spec |
| dataset | yes | nothing yet — Dagster schedule generation is `[later]` |
| metric | yes | nothing yet — consumers still resolve the head |
| app | yes | nothing yet — preview/staging/prod mapping is stream S's |
| knowledge | yes | nothing yet |
| connection | yes | nothing yet |

So for the five lower rows, going live today means "it appears in Run and the guard counts it as
ready" — it does not yet change which version anything executes. That gap is stated here rather
than implied, because a lifecycle that exists only as a label on a tile is a label.

**A dependency whose kind has no adapter at all** (a boot where registration failed) is treated as
**satisfied with a warning**, named in the confirm dialog and in the result. A refusal nobody can
clear would be worse than going live with a stated unknown.

## How to try something out, versus how to go live

**To try something out** you do nothing special. Work in **Studio**, run / build / preview the
draft with the kind's normal verify action. Nothing is scheduled, nothing is published, no
colleague's screen changes, and no approval is involved. The tile shows **Testing** while a test
is in flight and goes back to **Draft** when it settles.

**To go live** you press **Go live** (or call `go_live`). One dialog tells you exactly what starts
running — the schedule, the URL, the consumers — and you confirm. From then on:

- Run serves that version to everyone who may see the object.
- Editing creates a new draft. Run keeps serving the pin. The badge still says **Live**, and the
  button changes to *"Go live with this draft"*.
- **Retire** stops Run serving it. Nothing is deleted.

**The go-live guard.** An object may go live only if **its dependencies are live** — a dashboard's
metrics and datasets, a metric's dataset, an agent system's granted resources, an app's bindings.
The refusal **names** the offending dependency:

```
cannot go live: metric “Orders revenue” (Orders.revenue) is Draft, not Live.
Take it live first, then try again.
```

This is about **lifecycle, not audience**: a Live `My` metric is a perfectly good dependency for a
Live `My` dashboard. Promotion is never required to go live.

## What is PHYSICALLY separated, and what is only LOGICALLY

This is the section an IT reviewer should read first, because the honest answer is "less than you
might assume".

**Physically separated today:**

- **The pinned definition of an agent system.** A scheduled run reads the bytes at the live
  commit out of the repository. It is a different file revision, not a flag — and if that blob
  cannot be read, the scheduled run is **refused with the reason** rather than falling back to the
  head. A different version running than the one that was signed off is the failure the pin
  exists to prevent.
- **The pinned dashboard spec.** Run resolves the spec whose content digest equals the pin, out of
  the retained version history. If that version is no longer retained, Run shows **nothing** and
  says why; it never substitutes the draft.
- **Trino lanes.** A dataset build already writes to the author's personal lane or the domain
  schema depending on ownership, so a draft's tables and a domain's tables are different physical
  objects. The `__dev` schema for metric and dataset drafts is `[later]`.
- **Software app URLs.** Preview, staging and prod are different deployments. Mapping them onto
  Draft / Testing / Live is `[later]`, with S's environment model.

**Only logically separated:**

- **Everything else.** For metrics, datasets, knowledge and connections, Draft and Live are the
  same stored object with a pin recorded beside it. Going live does not copy anything and does not
  move anything; it records which version is the one that runs, and the surfaces that read the pin
  honour it. A surface that does not read the pin yet (see the `[later]` rows above) still reads
  the head, and that is a real limitation, not a rounding error.
- **The model gateway and the trace store.** A run carries the LiteLLM tag `env:studio|test|run`
  and sets the Langfuse trace `environment` to the same word, with a smaller budget share off Run
  so a draft cannot drain what is running. A **scheduled** run declares `env:run` (so production
  spend is never capped at a draft's share) and a run started by hand declares `studio`; the value
  rides the persisted run-queue record, so a worker-executed run is attributed like an inline one.
  That is attribution and budgeting on one shared gateway — not a separate gateway per lifecycle.
- **The database.** There is one OpenSearch mirror and one git repository per domain. A draft and
  a live version of the same object sit in the same index and the same repository.

## Day one

The migration marks **every existing object Live**, pinned at its own head, so the Run view on the
day this ships is exactly today's screens. It **runs once, at boot**, and it does nothing at all
unless the pin index could be read — logging and retrying on the next boot otherwise, never
guessing. It is idempotent twice over: an object that already carries a pin keeps it, and a
durable latch means a restart neither re-runs the migration nor resurrects something a user has
since retired.

**Before that migration has run, nothing has a pin** — so a scheduled agent run would be refused
for every system that works today. It therefore **fails open, once**: while the index has never
been populated the schedule runs the HEAD and logs exactly that, naming the fallback. The moment
the index exists the rule flips to fail-closed and stays there. Objects created afterwards start as **Draft** and are
absent from Run until someone goes live. Nothing an existing MCP client sends changes meaning:
`lifecycle` is an **optional** filter whose absence means "everything", and no tool anywhere
gained a required argument.

## The surfaces

- **The header toggle** — one segmented **Studio | Run** control, remembered per user. Studio
  shows drafts, what is being tested and live objects *for editing*; Run shows **only live**
  artefacts, for operating and consuming. Every tab's tile list applies it through one shared hook
  (`core/ui/lifecycle/useLifecycleView.ts`), so it means the same thing everywhere.
- **Two badges** on every tile: lifecycle and audience. Every tile list applies the toggle through
  the one shared hook, and the lifecycle badge is mounted on the Data, KPIs, Dashboards, Agents and
  Connections tiles. **Software and Knowledge tiles deliberately show no lifecycle badge**: each
  already renders its own `Draft` badge (an app's deploy state, a process's publish state), and two
  badges carrying the same word would be exactly the vocabulary collision the simplicity contract
  forbids. Those two lists still apply the filter. Reconciling each tab's own word with the
  lifecycle is a change inside that tab — deviation V-12.
- **One Go live button** with **one confirm dialog** — the existing shared dialog, not a new one.

## The MCP surface

Exactly **two** new tools:

| Tool | Arguments | Does |
|---|---|---|
| `go_live` | `kind`, `id`, **optional** `sha` | pins a version as the one that runs; refuses, naming the dependency, if one is not live |
| `retire` | `kind`, `id` | unpins; deletes nothing |

Plus, on every list tool over a lifecycle-bearing object: an **optional** `lifecycle` filter
(`draft` · `testing` · `live`), through one central helper, and `lifecycle` + `audience` on every
row. `run_tests` is **not** a tool, and there is no setter that takes a lifecycle word — `go_live`
and `retire` are the only two doors.

## Deviations from the plan, and what remains

- **`os/lifecycle/pins.yml`, not `os/lifecycle.yml`.** The pin file lives in its own reserved
  subtree. A single flat file under `os/` is not representable with today's git-store exports
  without either reserving all of `os/` — which would change the dbt generator's delete semantics
  for another stream's files — or a read-merge-commit race against it. The fix is one additive
  export, a path-scoped `commitPaths(domain, files, opts)`, after which the file can move and
  nothing above it changes.
- **No git tag yet** (above).
- **The pin is honoured for two kinds**, not seven (the table above says which). All seven can
  hold a pin.
- **Software and Knowledge tiles show no lifecycle badge** (above), because each already has its
  own `Draft` word. Both lists apply the filter.
- **A pin-only kind's ref is a record content digest** (`rev:<12 hex>`), not a commit sha, until
  that kind is git-backed — `core/infra/content-ref.ts` explains why that is the honest form.
- **"Consumers default to Run"** is not expressible: the role ladder
  (creator / builder / domain_admin / admin) has no consume-only role. Every role defaults to
  Studio today, and the default function already answers `run` for any future viewer role.
