# LangGraph JS

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`.

- **Licence:** MIT (every package below; `npm view <pkg>@<version> license`)
- **Source:** https://github.com/langchain-ai/langgraphjs · https://github.com/langchain-ai/langchainjs
- **Pinned as:** npm packages in `os-ui/package.json` (exact versions; `os-ui/package-lock.json` is the source of truth)
  - `@langchain/langgraph` 1.7.5
  - `@langchain/langgraph-checkpoint-postgres` 1.1.4
  - `@langchain/core` 1.4.2
  - `langchain` 1.6.7 (home of `createAgent`; used from the agent-factory step on)
  - `@langchain/openai` 1.8.4 (`ChatOpenAI` pointed at LiteLLM; used from the agent-factory step on)
- **Docs used:**
  - Interrupts (one `interrupt()` per pause, no non-deterministic loops, resume by interrupt id): https://docs.langchain.com/oss/javascript/langgraph/interrupts
  - Persistence and `PostgresSaver` (one `pg.Pool`, `setup()`, `getState`): https://docs.langchain.com/oss/javascript/langgraph/persistence
  - Human-in-the-loop: https://docs.langchain.com/oss/javascript/langchain/human-in-the-loop

**Why the OS ships it:** the agent engine. A team run is a LangGraph `StateGraph` checkpointed to
Postgres; a held write parks the run on LangGraph's own `interrupt()` and resumes with
`Command({ resume: { [interruptId]: decision } })`.

It is a library, not a deployment: it runs inside `os-ui` and `os-ui-worker`. CI checks that
`@langchain/langgraph` and `@langchain/core` resolve to exactly one copy each
(`os-ui/scripts/check-langgraph-single-copy.mjs`), because two copies break the async context
`interrupt()` relies on. Any glue we wrote lives in `os-ui/tabs/agents/lib/engine/`, never here.
