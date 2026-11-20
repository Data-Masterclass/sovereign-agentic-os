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

## WP-53: the agent system as a native LangGraph module

Versions as above (the generated `agents/<system>/package.json` pins exactly the installed ones;
`os-ui/tabs/agents/lib/module/versions.ts`). Docs used for the generated `graph.mjs` / `run.mjs`:

- Graph API (`StateGraph`, `Annotation`, `MessagesAnnotation`, `Command({ goto })`, `addNode(…, { ends })`): https://docs.langchain.com/oss/javascript/langgraph/graph-api
- Subgraphs (an agent invoked inside a node; checkpointer inherited; interrupts bubble up): https://docs.langchain.com/oss/javascript/langgraph/use-subgraphs
- Agents (`createAgent`, `version: 'v2'`, `systemPrompt`, `middleware`): https://docs.langchain.com/oss/javascript/langchain/agents
- Middleware (`createMiddleware`, `afterModel`) and human-in-the-loop (`humanInTheLoopMiddleware`, `interruptMode: 'per_call'`, `when`, `description`): https://docs.langchain.com/oss/javascript/langchain/middleware , https://docs.langchain.com/oss/javascript/langchain/human-in-the-loop
- Tools (`tool()` with a JSON schema): https://docs.langchain.com/oss/javascript/langchain/tools
- `ChatOpenAI` against an OpenAI-compatible endpoint (`configuration.baseURL`): https://docs.langchain.com/oss/javascript/integrations/chat/openai

### Revision of component-design 03 (WP-53, 2026-11-20)

These two points override 03 Revision 1 (the `holds` channel) and 03 §5.4 / Revision 6 (the owner
stamp in graph state) for the module engine. Both were measured against the installed packages.

1. **The once-per-call hold decision lives in the OS table `agent_hold_decisions`, not in a graph
   state channel.**
   - Measured in `langchain` 1.6.7: with `createAgent({ version: 'v2' })` each tool call is a `Send`
     task. The request that `wrapToolCall`, and so the stock HITL `when`, receives carries only
     `messages` in `state`, not middleware channels (`ReactAgent.js:179`). `version: 'v1'` throws
     for per-call HITL (`ReactAgent.js:169`). `runtime.context` is per-invoke input and cannot hold
     a mid-run decision.
   - Mechanism:
     - `holdDecider` (`afterModel`) records `{held, approverRole}` per `<thread>:<toolCallId>`. The
       first write wins, before any tool of the turn runs.
     - The HITL `when` reads only that row; a missing row is held for an admin.
     - Retention deletes the rows with the thread.
   - Alternative considered: the decision in the AI message's `response_metadata`. It was verified
     to work, but it is not adopted. It writes OS governance data into the native transcript, which
     `run.mjs` and any LangGraph tool would then carry, and contract C2 keeps OS metadata out of
     native state. Revisit it if checkpoint time travel must replay holds.
2. **The run's owner and module stamp live in the OS table `agent_module_runs`.**
   - Measured in LangGraph JS 1.7.5: `config.metadata` is not copied into checkpoint metadata, which
     holds `source, step, parents` only.
   - The stamp holds: owner (system, user, domain), the module digest and the commit.
   - A resume loads the module from the stamped commit and verifies it against the stamped digest,
     so it never uses the repo HEAD. A run without a stamp started on the v1 graph and resumes there.

Measured in `langchain` 1.6.7 (not stated in the docs): with `version: 'v2'`, the request a
`wrapToolCall` middleware (and the HITL `when` predicate) receives carries only `messages` in its
`state`, not middleware state channels. The OS therefore keeps its once-per-call hold decision in
its own table, not in a middleware channel. LangGraph JS 1.7.5 does not copy `config.metadata`
into checkpoint metadata, so the module run's owner stamp is an OS table too.
