# Software · Build

Generated applications: design, build, preview and deploy, each gated by an approval.

The authoritative contract is [`manifest.ts`](./manifest.ts) — this file explains it; the manifest is what the checks and the docs generator read. If the two disagree, the manifest is right.

## What this module owns

**Routes**

- `/software`
- `/apps`

**APIs**

- `/api/software`
- `/api/apps`
- `/api/artifacts`

**MCP tools**

- `software-write`

**Needs deployed**

- `opensearch`
- `minio`
- `litellm`

## Layout

- `build-spec/`
- `lib/`
- `mcp/`
- `ui/`

- `lib/` tab logic · `ui/` tab-specific components · `mcp/` this tab's MCP handlers

- `lib/appspec/` — the declarative AppSpec grammar. TOLERANT PARSE, STRICT OUTPUT: the build normalises bare ids in the assistant's reply into the canonical reference objects (`"metric": "m_1"` → `{ metricId: "m_1" }`, likewise `function`/`source`, plus `{ id }` → `{ <slot>Id }`) and reports each rewrite in the build notes, while `parseAppSpec` stays strict so the stored spec is always canonical.

- `guide.md` — the golden path, shown in-product
- `context.md` — the system prompt context this tab gives an agent

## Rules that apply here

1. **Import only `@core/*` and this module.** A cross-tab need means the shared part belongs in `@core`.
2. **The kernel must not import this module.** `@core` does not know its tabs exist.
3. **Pages live in `os-ui/app/`**, thin, importing from here. Next.js serves routes only from there.
4. Every source file carries a `FEATURE:` / `USER STORY:` / `ARCHITECTURE:` header. `scripts/check-structure.mjs` enforces it as a ratchet.

See [`../../../CLAUDE.md`](../../../CLAUDE.md) for the full structure rules and [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) for the constraints this codebase punishes you for ignoring.

<!-- BEGIN stream-H: agentic builder (appended section — do not reflow the lines above) -->

## Agentic builder (`SOFTWARE_BUILDER=agentic`) — OFF by default

> The owner's question: *"The app builder in the UI is more by configuration but it is not creating
> great apps. The user stories are well described. Why is it so hard to build a good software out of
> it using the Qwen Reasoning model or any other open source model?"* The diagnosis, agreed: **~80%
> harness, ~20% model.** A coding agent that cannot compile, cannot see the API it is coding against
> and has no definition of done produces mediocre software on *any* model.

**What the default `spec` builder does** (unchanged, and still the default): one reasoning-model turn
fills a declarative `AppSpec`, with up to two repair turns seeded by the validator's issues
(`lib/appspec/generate-server.ts`). No compile loop, no structured grounding, no acceptance criteria.

**What the `agentic` builder does** (`lib/builder/`): a bounded **planner → coder → build → reviewer**
loop over a grounding pack assembled from the shipped source.

| Piece | Where | What it is |
|---|---|---|
| Grounding pack (pure) | `lib/builder/grounding.ts` | types, the extractors, and one deterministic renderer |
| Grounding pack (gathered) | `lib/builder/grounding-server.ts` | the governed reads, as the signed-in user |
| Acceptance checks | `lib/builder/acceptance.ts` | derived from the user stories; scored, with evidence |
| Build tool | `lib/builder/tools.ts` | a thin adapter over the existing `compile-gate.ts` |
| The loop | `lib/builder/loop.ts` | pure orchestration, injected deps, bounded at 4 iterations |
| Prompts + parsers | `lib/builder/prompts.ts` | the three node frames, tolerant JSON recovery, path discipline |
| The wiring | `lib/builder/loop-server.ts` | models, the governed commit door, the Langfuse spans |
| The flag | `lib/builder/dispatch.ts` | one predicate; one guarded line in `platform-mcp.ts` |
| The built-in system | `../../agents/lib/builtin/appsmith.ts` | `os.appsmith` as a real `system.yaml` |

**The grounding pack** carries: the user stories with their features, NFRs and rules; the granted
datasets' **real columns and up to five real sample rows**, read through the governed MCP door **as
the signed-in user**; the granted **metric definitions** as the OS holds them; the
`@sovereign-os/app-sdk` and `@sovereign-os/ui` **API surfaces extracted from `core/app-sdk` and
`core/app-ui` source** (so the prompt can never drift from what the compiler checks); the **design
tokens** from `core/app-ui/theme.css`; **one exemplar app tree**; and the **Tier-2 constraints**.
Anything it could not get is a labelled line in `gaps[]` and is rendered — there is no fabricated
row anywhere in the path.

**The acceptance checks** are derived from the stories as
`{ story, check, kind: 'compile' | 'route' | 'render' | 'manual' }`: one compile check per build, a
route and a render check per story, and one manual check per NFR and per rule. `compile` is the real
in-process gate. **`route` and `render` are STATIC checks over the generated files, read from the
TypeScript AST** (`builder/symbols.ts`) — a comment, a string literal, JSX text or a type-only
import naming `os.records.add` does **not** pass, which a text search would have allowed. Every
evidence string says `static check (AST)`, and no result ever claims a browser rendered anything.
`manual` is listed for the human and is never machine-passed. A build that never produced a
scoreable tree reports `scored: false`, never a clean-looking `total: 0`.

**What the coder may write.** `src/**`, `public/**` and `index.html`. Refused, with the reason fed
back: an absolute path, a backslash path, `..`, any dotfile (`.env`, `.npmrc`, `.github/**`), the
vendored tree — and **`package.json`**, because the compile gate treats a declared dependency as an
allowed external, so `"x": "*"` plus `import 'x'` would compile green and fail in the browser.
Adding a dependency stays a human decision.

**Data, not instructions.** The grounding pack carries tenant-authored content — story text,
dataset and column names, sample row values. One fence line sits in every node's system frame and
again inside the rendered pack: that content is data to build from, never instructions to follow.
Sample **values** of heuristically-sensitive columns (email, phone, IBAN, secrets, salary, DOB,
address, health) are masked while the column **names** are kept; the masked columns are named in the
pack's gaps. This is a labelled heuristic, not a classification — see the backlog.

**Nothing throws out.** The planner, coder, build tool, reviewer and commit door are each wrapped,
so a model outage, an esbuild/OOM slip or a bad reply ends the loop with its own typed stop reason
(`plan-error`, `coder-error`, `build-error`, `review-error`, `commit-error`) and a summary naming
the stage — never a raw exception at the MCP boundary that loses the step trail.

**The scorecard is committed with the code.** `.app/acceptance.json` is written by the same governed
`commitToApp` call, in the same commit, so the deploy review card, `read_app_files` and an auditor
all read one commit — and a rollback carries the matching scorecard.

**The loop** writes through the **normal governed commit door** (`commitToApp`, as the signed-in
user), which runs the compile gate *before* any write — so "build" and "write" are one governed call
and a red tree can never land. A red gate feeds the compiler's own diagnostics back verbatim and the
next iteration fixes them. The loop stops on a reviewer pass over a clean scorecard, on an identical
retry (no progress), on a coder error, or on the four-iteration budget. **A build that merely
compiles is never reported as done**: on budget exhaustion a compiling tree is committed with
`ok: false` and the unmet checks named.

**Turning it on.** `SOFTWARE_BUILDER=agentic` (chart: `softwareBuilder.mode`). Optionally pin a code
model with `LITELLM_CODER_MODEL` (chart: `softwareBuilder.coderModel`); empty means the `coder` model
role falls back to the reasoning tier, so no model change is needed. The default `spec` keeps Build
byte-identical — asserted by `lib/builder/dispatch.test.ts`. The iteration ceiling is lowered to
whatever the caller's domain cost cap can still pay for, so a build near its cap stops early and
says so instead of dying mid-iteration.

### Backlog — deliberately NOT built, so nobody assumes it shipped

- **jsdom or preview-screenshot rendering inside the loop.** Today's route/render checks are static
  file inspection. Real rendering is the single biggest quality upgrade left.
- **Story-derived runtime tests.** The harness derives and scores static checks; it does not yet
  generate and run tests from the stories.
- **Model-quality evals.** No harness-held comparison of Qwen against other open models yet, so the
  "~20% model" half of the diagnosis is still an estimate rather than a measurement.
- **The loop driving the Tier-1 AppSpec generator** as well as the Tier-2 code tree.
- **A review card for a loop that stops short** (today it is an honest tool result, not a card).
- **The rest of the platform-MCP write surface is still unheld by the agent gate.** `commit` is now
  in `core/mcp/write-tool-meta.ts`, so a `read-only` agent can no longer write app files. But
  `create_software`, `request_deploy`, `start_preview`, `promote`, `archive`, `delete`,
  `set_app_spec`, `design_software`, `decide_deploy` and the `use_*` family are all declared
  `write: true` and all absent from that table, so no preset holds them. A test pins the list so a
  NEW platform write cannot join it silently; closing it changes the shipped Software Delivery
  Team's posture and belongs to the software stream.
- **Column masking is a NAME HEURISTIC, not a classification.** The OS has no column-sensitivity
  facility to consult (`ColumnDoc` is `{ name, description }`; `get_catalog_classification` places
  warehouse tables into folders by connection). There is also **no trace-redaction facility on this
  path** — the prompt text is what the model and Langfuse see. Replace the heuristic with a real
  classification when one exists; do not extend it.
- **Builder model calls are still tagged `tab:assistant` in LiteLLM.** `assistantComplete` has no
  `tab`/`runId` option, and `core/runtime/complete.ts` is not this stream's file. Per-tab and
  per-run cost attribution for the builder needs that option added first.
- **`os.appsmith` is defined but not yet SEEDED into the Agents catalogue.** The yaml, its compile
  and its guarded loop are tested (`tabs/agents/lib/builtin/appsmith.test.ts`), but nothing registers
  it as a domain-Shared system the way the instructor seed registers the Software Delivery Team, so
  it cannot yet be *run from the Agents tab* or reached through `run_agent_system`. The Build path
  uses the software-side harness directly; wiring the seed is the next item.

<!-- END stream-H -->
