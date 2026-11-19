# LangGraph — the agent graph engine

**What it is:** LangGraph (MIT) is the library that runs an agent team as a graph of steps and
saves the run's state after every step. It is a library inside `os-ui` (and the `os-ui-worker`),
not a separate service: nothing is deployed for it. Installed: `@langchain/langgraph` 1.7.4 and
`@langchain/langgraph-checkpoint-postgres` 1.1.3 (`os-ui/package.json`). The LangGraph Platform is
not used.

## What the OS uses it for today

- Ordering the steps of a run: four steps per agent (plan, act, tools, route) in one graph
  (`os-ui/tabs/agents/lib/engine/build-graph.ts`).
- Saving the run's state in Postgres so a run can pause for an approval and continue after a
  restart (`os-ui/tabs/agents/lib/engine/checkpointer.ts`).
- Pausing for a person with `interrupt()` when a write needs approval.

## What the OS does not use it for today

The loop "ask the model, run its tools, ask again", the supervisor, retries, time limits, the
trimming of long conversations, parallel work and the live progress feed are written by hand or do
not exist. LangGraph has features for most of them.

## Where the full description is

The agent engine has its own documentation folder, `docs/agents/`:

- `docs/agents/how-an-agent-runs.md` — today's behaviour, step by step
- `docs/agents/feature-map-langgraph.md` — every LangGraph feature: used, hand-built, not used
- `docs/agents/known-defects.md` — what is known to be wrong
- `docs/agents/design.md` and `docs/agents/plan.md` — the proposed design and delivery plan

Online: https://github.com/Data-Masterclass/sovereign-agentic-os/tree/main/docs/agents
