# Agents: how they are built, how they run, and what we propose to change

This folder is the single source of truth for the agent engine of the Sovereign Agentic OS: what
a team of agents is, what Build does, what happens in a run, what is sent to the model, what
happens with the reply, which features of LangGraph, LiteLLM and Langfuse are used, what is known
to be wrong, and what we propose to do about it.

It is written to be read by the owner of the product first. Plain words come first, exact code
references second.

## The pages

| Page | What it is for | Who should read it | Fact or proposal |
|---|---|---|---|
| [`how-an-agent-runs.md`](how-an-agent-runs.md) | A step-by-step walk through today's behaviour: the definition, Build, a run from click to answer, exactly what is sent to the model, and what the OS does with every kind of reply. | Everyone. Start here. | Fact (today) |
| [`feature-map-langgraph.md`](feature-map-langgraph.md) | A table of every LangGraph feature: what it is for, whether the OS uses it, where, and what we propose. | Anyone who asks "do we use X?" | Fact (today) and proposal (target), in separate columns |
| [`feature-map-litellm.md`](feature-map-litellm.md) | The same table for LiteLLM, the model gateway. Says which features need the paid edition and are therefore not usable. | Same, and admins | Fact and proposal, in separate columns |
| [`feature-map-langfuse.md`](feature-map-langfuse.md) | The same table for Langfuse, the trace store. | Same, and admins | Fact and proposal, in separate columns |
| [`known-defects.md`](known-defects.md) | Everything known to be wrong, ranked, with evidence, severity, status and the phase that fixes it. | The owner, and whoever picks the next piece of work | Fact (today) |
| [`design.md`](design.md) | The proposed design: principles, the central choice, the target run, the gateway, tracing, the table of Simple and Developer settings, and the decisions the owner must take. | The owner, before any work starts | **Proposal. Not yet agreed.** |
| [`plan.md`](plan.md) | The proposed delivery in six phases, each with scope, tests, risks and an exit check, and the "12 invoices" benchmark. | The owner and the people doing the work | **Proposal.** |

A short pointer also exists at `docs/components/langgraph.md`, so that LangGraph has a page next to
the other components.

## What "today" means on these pages

| | |
|---|---|
| Code state | Commit `b47e2cd53f6fe2ba3def93f28e385f04fa91b899` on `main` (short: `b47e2cd5`), 2026-11-19 |
| How it was verified | By reading the code and the chart. Nothing was executed and no test was run for these pages. |
| Live facts | A small number of statements are marked "live" or "seen on the live system". They were observed on the production system on 2026-11-19 by the investigation that preceded these pages. They were not re-checked while writing. |
| Line numbers | From the code trace of the same commit. A sample was re-checked against a fresh clone while writing (the model client, the key handling, the failure path, the prompt texts, the chart's gateway settings). Not every line number was re-checked. |
| Research | The feature lists and version numbers for LangGraph, LiteLLM and Langfuse come from research done on 2026-11-19. Its sources are listed at the end of each feature map. |
| Path convention | Paths are relative to `os-ui/` unless they start with `charts/`, `docs/` or `values`. |

Production facts used on these pages (all observed 2026-11-19):

- The run worker is switched on: one `os-ui-worker` replica. The web process (`os-ui`) also runs as one replica. The chart's default is the opposite, worker off (`charts/sovereign-agentic-os/values.yaml:1408-1409`).
- LiteLLM is version 1.90.0. Langfuse is version 3.194.1.
- The LiteLLM gateway is reachable from the internet at its own hostname, with only its own key check in front.
- The OS has its own price book (`MODEL_PRICES_JSON`).
- One real run of a two-agent invoice team used about 185,000 tokens in ten model calls, failed on the limit of 200,000 tokens per minute, and its failed first agent still handed off to the second.

## Words used for certainty

| Word | Meaning |
|---|---|
| verified in code | Read at the lines given. |
| live | Seen on the production system on the date given. |
| suspected | Follows from the code or the research. Nobody has shown it happen. |
| estimate | A calculated number, not a measurement. To be replaced by a measurement. |
| not verified / not confirmed | We do not know. |
| in progress | A pull request is open. It is not merged. |
| proposed | Not built. Not agreed. |

## How to keep these pages true

The rule: **a pull request that changes how agents behave updates the matching row in this folder,
in the same pull request.**

| If the pull request changes... | Update |
|---|---|
| what is sent to the model, or how a reply is handled | the tables in sections (d) and (e) of `how-an-agent-runs.md` |
| what Build does or checks | section (b) of `how-an-agent-runs.md` |
| the steps of a run, hand-offs, approvals | section (c) of `how-an-agent-runs.md` and its two diagrams |
| the use of a LangGraph, LiteLLM or Langfuse feature | the row in the matching feature map: the status word, the note and the "Where" column |
| a version of LangGraph, LiteLLM, Langfuse or their SDKs | the "Installed versus latest" table of the matching feature map |
| a defect | its row in `known-defects.md`: status becomes "fixed in <version>" once it is released |
| a setting of an agent system | the settings table in `design.md`, section 6: the "Today" column |
| a phase | `plan.md`: tick the exit check, and write the measured benchmark numbers into the table |

Three more habits:

1. When a proposal in `design.md` is agreed, change its status line at the top. When it is built, move the description into `how-an-agent-runs.md` and leave one line behind.
2. Never describe planned behaviour in the present tense. "The engine waits" is for things that are built. "The engine will wait" or "proposed:" is for the rest.
3. When the date and commit above are more than a release old, re-check the sampled lines and update the date.

## What these pages do not cover

- The builder's own model calls (the stage assistants, "propose a team", the judge) are described in the code trace but only touched on here.
- The tab assistants and Ask the OS. They use a second copy of the agent loop (`core/runtime/agentic.ts`), noted as defect F18.
- The individual tools. Only the agent's tool executor was traced, not what each tool does inside.
- Private deployment values. Only the chart and the public overlay were read.
