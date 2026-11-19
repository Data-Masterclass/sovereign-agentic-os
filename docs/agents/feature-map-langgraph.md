# Feature map: LangGraph

LangGraph is the open-source library (MIT licence) the OS uses to run an agent team as a graph of
steps with saved state. This page lists each LangGraph feature and says how the OS uses it today
and what we propose.

- "In the OS today" was verified by reading the code at commit `b47e2cd5` (2026-11-19).
- "Target", "Simple mode default" and "Developer mode override" are the **agreed direction (2026-11-19), not built** unless a row says so. See [`design.md`](design.md).
- "Phase" refers to [`plan.md`](plan.md). A dash means no change is planned.
- Paths are relative to `os-ui/` unless they start with `charts/`, `docs/` or `values`. `build-graph.ts` means `tabs/agents/lib/engine/build-graph.ts`. `run.ts` means `tabs/agents/lib/engine/run.ts`.

Status words:

| Word | Meaning |
|---|---|
| **Used** | The library feature itself is used. |
| **Hand-built** | The OS has its own code that does this job instead of the library feature. |
| **Not used** | Neither the library feature nor an OS equivalent exists. |
| **Misused** | The feature is used in a way that does not do what is intended. |
| **Blocked** | Only in a paid edition. Not usable under the licence rule. (LangGraph has no such rows; the word is listed for consistency with the other two maps.) |

## Installed versus latest

| Package | Installed | Latest (2026-11-19) | Gap |
|---|---|---|---|
| `@langchain/langgraph` | 1.7.4 | 1.7.5 | One patch. Speed improvements only. |
| `@langchain/langgraph-checkpoint-postgres` | 1.1.3 | 1.1.4 | One patch. Fewer database round trips per checkpoint. |
| `@langchain/core` | 1.4.0 | 1.4.2 | Two patches. Their notes were not reviewed. |
| `langchain` (home of `createAgent` and middleware) | not installed | 1.6.7 | See the central choice in [`design.md`](design.md). |

Installed versions are pinned in `package.json:20-22`.

## The five biggest gaps

1. **LangGraph only orders the steps and saves state.** The tool loop, the supervisor, retries (there are none), trimming and the live feed are hand-built (`build-graph.ts:755-1154`).
2. **No retry and no time limit on any step.** `RetryPolicy`, node timeouts and `errorHandler` are in the installed version and unused. One rate-limit reply from the gateway fails an agent.
3. **A failed agent does not stop the run.** A `Command` that says "end" and a conditional edge are attached to the same step; the edge wins. This is a documented LangGraph pitfall (defect F1).
4. **Nothing runs in parallel.** `Send` is unused. Twelve documents are twelve turns of one growing conversation.
5. **Approvals use `interrupt()` but not its newer safety features:** no response schema, no answer by interrupt id, no protection against a write running twice after a crash.

---

## Graph model

| Feature | What it is for | In the OS today | Where | Target | Simple mode default | Developer mode override | Phase |
|---|---|---|---|---|---|---|---|
| `StateGraph` with a state schema | Defines the steps and the shared state they read and write. | **Used.** Built with `Annotation.Root`, which the LangGraph docs now label legacy. | `build-graph.ts:277-294`, `:1199` | Keep. Move to `StateSchema` when the state is rewritten. | Generated from `system.yaml`. | Extra typed state values (`state.channels`). | 2 |
| Message reducer | Keeps a chat history: adds new messages, updates by id, allows deletion. | **Hand-built.** The OS has its own append list. The shared `messages` value is declared but no step ever writes it. Each agent's conversation lives in a private cursor instead. | `build-graph.ts:426-435`, `:280-293` | Use the library's message state inside each agent's subgraph. | Always on. | None. | 2 |
| Reducers and `Overwrite` | Say how two updates to the same value are merged, or replace it outright. | **Used.** One append rule and one last-value rule. `Overwrite` is not used. | `build-graph.ts:277-294`, `:633-641` | Keep. Add an append rule for results coming back from parallel work. | Automatic. | Custom merge rule per state value. | 2 |
| Input, output and private schemas | Limit what goes into a graph and what comes out. | **Not used.** | — | Output = final answer plus declared outputs. Private state for each agent. | Automatic. | None. | 2 |
| `UntrackedValue` | State that is used during a run but never saved. | **Not used.** | — | Out of scope. Nothing needs it; unsaved state is lost on resume. | — | — | — |
| Conditional edges | Choose the next step from the state. | **Used.** For act to tools or route, tools to tools or act, and the supervisor's choice. | `build-graph.ts:1203-1211`, `:1221` | Keep, but never on a step that also returns a `Command` with a target. | Generated from hand-offs. | Hand-off conditions (`edges[].when`). | 0 |
| `Command` (update and go to) | Lets a step update state and name the next step in one return. | **Misused.** On failure the act step returns "go to the end", but the same step also has a conditional edge. Both run, the "end" adds nothing, so the next agent starts anyway (defect F1). Elsewhere it is used correctly. | `build-graph.ts:748-751`, `:1203-1206` | One routing method per step. A failed agent stops the run unless a failure hand-off is declared. | Stop on failure. | Declare a failure hand-off. | 0 (fixed on main: PR #91, merged) |
| `Command.PARENT` | Lets a step inside a subgraph hand control to the outer graph. | **Not used.** There are no subgraphs. | — | Used for hand-offs once each agent is a subgraph. | Hidden behind "hands off to". | None. | 2 |
| `Send` | Starts the same step many times in parallel, once per item. | **Not used.** The graph is strictly one step after another. | — | A "for each item" step with a concurrency cap. | Off until an agent is marked "process each item separately"; then 4 at a time. | Concurrency and maximum items, within the admin cap. | 2 |
| Deferred nodes | Make a step wait until all parallel branches are finished. | **Not used.** | — | Applied automatically to the step that collects "for each" results. | Automatic. | None. | 2 |
| Recursion limit | A hard cap on the number of steps, as a safety net. | **Used** as a backstop: step budget × 4 + 8. Hitting it is reported as "interrupted". | `build-graph.ts:358-360`; `run.ts:205` | Keep as a backstop. The real limits are the tool-round and step budgets, reported in plain words. | Derived from the budgets. | None directly. | 2 |

## Agents

| Feature | What it is for | In the OS today | Where | Target | Simple mode default | Developer mode override | Phase |
|---|---|---|---|---|---|---|---|
| Prebuilt agent loop (`createAgent`; older `createReactAgent`) | A ready-made "model calls tools until done" loop. | **Hand-built.** The act and tools steps are the loop. A second copy of the same loop exists for the tab assistants. | `build-graph.ts:820-1070`; `core/runtime/agentic.ts:443-915` | Keep one OS-owned loop, rebuilt on library parts (option A). `createAgent` is option B. See [`design.md`](design.md). | One loop. | None. | 2 |
| `ToolNode` and `toolsCondition` | Run the tool calls of a reply and route on whether there are any. | **Hand-built.** The tools step runs one call per graph step, after the policy and hold checks. | `build-graph.ts:896-1070` | Keep an OS tool step, because every call must pass policy, hold and identity in one place. | Automatic. | None. | 2 |
| Tool error handling | Decide whether a failed tool call goes back to the model or is retried. | **Hand-built.** Errors go back to the model as a typed error. Four failures in a row stop the loop. No retry of temporary failures. | `tabs/agents/lib/engine/tool-result.ts:157-189`; `build-graph.ts:1051-1059` | Keep. Add up to two retries for temporary failures of read tools. | On. | Retries per tool kind. | 2 |
| Parallel tool calls | Let the model ask for several tools in one reply. | **Not used.** The setting is not sent, so the model decides. Several calls are run one after another. | `core/runtime/runtime.ts:180-190`; `build-graph.ts:902-1070` | Send the setting explicitly. Reads may run side by side; writes always one at a time. | Off for agents with write tools; on for read-only agents. | Per agent. | 2 |
| Structured output | Make the final answer follow a declared structure and check it. | **Not used** on the run path. | — | Optional per agent: a declared structure, checked, with one repair turn. Required for "for each" items. | Off, except "for each" items. | Structure, strictness, repair turns. | 2 |
| Forced tool choice | Require the model to call a tool. | **Not used.** Always `auto`, including for the supervisor's "must call" `route` tool. | `core/runtime/runtime.ts:187-190`; `build-graph.ts:1157-1175` | Force where a call is required: supervisor decision, "for each" extraction. Needs a test against the gateway first. | Automatic. | Per agent: auto, required, none. | 0 (test), 2 |
| Model fallback | Try a second model when the first fails. | **Not used** in the engine. The STACKIT overlay configures gateway fallbacks only. | `values.stackit-managed.yaml:134-137` | One fallback, configured at the gateway, only to models the key allows. | The gateway's fallback. | Fallback model per agent. | 0, 4 |
| Call limits | Cap the number of model and tool calls. | **Hand-built.** A step budget per run and a tool-round cap per agent visit. Defaults 400 and 100. | `build-graph.ts:363-366`, `:718-721`; `core/kernel/config.ts:377`, `:383` | Keep, with much lower defaults, as per-system settings. | 10 tool rounds per agent, 60 steps per run. | Both, within the admin cap. | 1, 4 |
| Subagents as tools | A main agent calls specialists as if they were tools. | **Not used.** | — | Later option. The supervisor pattern covers today's teams. | — | — | Later |
| Handoffs | The active agent passes control to another agent. | **Hand-built.** Hand-off edges with a small condition language and a tool for setting state. | `tabs/agents/lib/engine/when.ts:10-18`; `build-graph.ts:1099-1106`, `:443-459` | Keep the declared hand-offs. Implement them with `Command.PARENT` between subgraphs. | A straight chain. | Conditions and failure hand-offs. | 2 |
| Router | Classify the task, then send it to one agent. | **Hand-built.** The supervisor's decision call with a `route` tool. | `build-graph.ts:1157-1196` | Keep. Force the tool call. | Automatic for supervisors. | None. | 2 |
| Supervisor and swarm libraries | Ready-made multi-agent graphs. | **Not used.** | — | Stay unused. They are built on the deprecated agent and are in maintenance. | — | — | — |
| Subgraphs | Use one graph as a step in another. | **Not used.** Each agent is four flat steps of one graph. An older plan calls them a subgraph; they are not. | `build-graph.ts:1150-1153`; `docs/superpowers/plans/2026-11-13-engine-rebuild.md:75` | One subgraph per agent. | Automatic. | None. | 2 |
| Evaluator-optimizer loop | One agent writes, another criticises, repeat. | **Not used** as a pattern. A team can be drawn that way by hand. | — | Offered as a template with at most two rounds. | — | Rounds. | 4 |

## Saving state, pausing for people, reliability

| Feature | What it is for | In the OS today | Where | Target | Simple mode default | Developer mode override | Phase |
|---|---|---|---|---|---|---|---|
| Postgres checkpointer | Saves run state so a run can pause and continue. | **Used.** | `tabs/agents/lib/engine/checkpointer.ts:44-65` | Keep. Stop saving large tool results inside it. | Always on. | None. | 1 |
| Checkpoint clean-up | Stops the saved state from growing for ever. | **Hand-built.** A sweep deletes runs settled more than 30 days ago; parked runs are kept. LangGraph has no built-in expiry. | `tabs/agents/lib/engine/retention.ts`; `charts/sovereign-agentic-os/values.yaml:1404` | Keep. | 30 days. | None (admin setting). | — |
| Durability mode | Chooses when checkpoints are written. | **Not used.** The option is not passed. Which mode is the default was not confirmed. | `run.ts:179`, `:193` | Set it explicitly: `sync` for runs with writes or approvals. | `sync`. | `async` for read-only systems. | 2 |
| Idempotency and `task` | Make sure a write does not happen twice when a step is run again. | **Hand-built, partly.** An approval is keyed by run and call id. A write that timed out is not re-sent in the same visit. A write in flight during a crash has no such protection (suspected defect S4). `task` is not used. | `tabs/agents/lib/engine/approvals-bridge.ts:38-70`; `build-graph.ts:992-1003` | Every write carries an idempotency key made from saved state. An unknown outcome stops and asks a person. | Always on. | None. | 2 |
| Time travel (history, replay, fork) | Look at earlier states of a run, or run again from one. | **Not used.** Only the latest state is read. | `run.ts:162`, `:212`, `:291` | Read-only run history from checkpoints. No replay for users: replay repeats writes. | History visible. | None. | 2 |
| Store (memory across runs) | Keeps facts between runs and conversations. | **Not used.** `memory_md` is fixed text written by the builder. | `tabs/agents/lib/build/agentic-graph.ts:491-492` | Optional. Off by default. Kept per system and user. | Off. | On, with a size limit. | Later (decision D18) |
| Trimming and summarising | Keep what is sent to the model within a size budget. | **Hand-built.** Trimming only, and only above about 118,880 tokens. No summarising. The `tools` part is not counted. | `core/runtime/agentic.ts:374-434`, `:348-358` | A per-agent input budget far below the model's limit; summarise beyond it. | 24,000 tokens per call. | Budget and summary threshold, within the admin cap. | 1 |
| Clearing old tool results | Replace old tool outputs in the model input with a short placeholder. | **Not used.** Every result is re-sent in full on every later call of the visit. | `build-graph.ts:870-876`, `:971-974` | Results stored once, referenced in state; only the newest stay in the model input. | Keep the last 3 in full. | Number kept; tools that are never cleared. | 1 |
| `interrupt()` and resume | Pause the run for a person and continue with their answer. | **Used.** A held write pauses the run. The answer is matched by the OS's own approval id, not by LangGraph's interrupt id. No response schema. | `build-graph.ts:949`; `run.ts:184` | One interrupt per held call, with a response schema, answered by interrupt id, strict about stale answers. | Automatic before held writes. | None. | 2 |
| Static breakpoints | Pause before or after a named step. | **Not used.** | — | Stay unused. The LangGraph docs advise against them for approvals. | — | — | — |
| `RetryPolicy` | Retry a failed step with growing waits. | **Not used.** Every model call is tried once. | `core/runtime/runtime.ts:224-232` | On for model steps and read tools. Off for writes. | 3 attempts for errors; up to 5 waits for rate limits. | Attempts and waits, within the admin cap. | 0 (rate limits: on main, PR #91, merged), 2 |
| Node timeouts | Stop a step that runs or stays silent too long. | **Not used.** The OS has its own 240-second limit per model call and 60 seconds per tool call. | `core/runtime/runtime.ts:153`; `tabs/agents/lib/engine/tool-result.ts:165-189` | Library timeouts on every step, in line with the gateway's own limits. | 5 minutes per model step, 60 seconds per tool. | Per agent, within the admin cap. | 2 |
| `errorHandler` and node defaults | One place that decides what happens after retries are used up. | **Not used.** Each step has its own try/catch. Several errors are swallowed (defect F15). | `build-graph.ts:581-593`, `:838-840` | A graph-wide default that marks the run failed with a readable reason. | Automatic. | Failure hand-off per agent. | 2 |
| Node cache | Reuse a step's result for the same input. | **Not used.** | — | Out of scope. Stale results are a risk and nothing needs it. | — | — | — |
| Drain and cancel | Stop a run cleanly at the next step. | **Hand-built.** A stop signal is passed to the stream; on shutdown the job is queued again. `RunControl` is not used. | `run.ts:179`, `:193`; `tabs/agents/lib/build/run-jobs-server.ts:310-315` | Keep the queue. Use `RunControl` drain for the clean stop. | Automatic. | None. | 2 |
| `maxConcurrency` | Cap how many steps run at the same time. | **Not used.** Nothing runs in parallel. | — | Cap for "for each" work, to protect the gateway. | 4. | Up to the admin cap (8). | 2 |

## Live progress, settings, tests

| Feature | What it is for | In the OS today | Where | Target | Simple mode default | Developer mode override | Phase |
|---|---|---|---|---|---|---|---|
| Stream modes | Send events out of a running graph. | **Used**, narrowly: `custom` for three event types, `updates` only to notice a pause. No word-by-word text. Events are written to a table and read back every 400 ms. | `run.ts:179`, `:193`; `build-graph.ts:542-544`; `tabs/agents/lib/engine/jobs.ts:363-399` | Add `messages` for live text and tool progress. Keep the table so a second browser tab can follow. | On. | None. | 2 |
| Event streaming v3 | A newer, typed way to read the same events. | **Not used.** | — | Consider when the live feed is rebuilt. Not required. | — | — | Later |
| Tracing callbacks | Let a tracing tool record every step automatically. | **Hand-built.** The OS wraps each step in its own Langfuse spans. | `build-graph.ts:581-593`; `tabs/agents/lib/engine/observe.ts:206-332` | Langfuse's handler for LangGraph, after the SDK change. See [`feature-map-langfuse.md`](feature-map-langfuse.md). | Always on. | Extra tags. | 3 |
| Runtime context | Pass per-run facts (user, tenant, model) into steps in a typed way. | **Not used.** The facts are captured when the graph is built, and the graph is rebuilt for every run. | `tabs/agents/lib/build/agentic-graph-server.ts:308-424` | Use it, so one compiled graph can serve many runs. | Automatic. | None. | 2 |
| Dynamic model, prompt and tools | Choose these per run or per step. | **Hand-built.** The model per agent and the prompt are worked out by OS code. | `tabs/agents/lib/build/agentic-graph.ts:258-269`, `:488-497` | Keep in OS code, driven only by `system.yaml` and admin settings. | From the definition. | Model per agent. | 4 |
| Fake models and step tests | Test a graph with scripted model replies. | **Hand-built.** Engine tests pass in a scripted model function. | `tabs/agents/lib/engine/build-graph.test.ts:380-388` | Keep the OS's own scripted model. `fakeModel` needs the `langchain` package. | — | — | 0 onwards |
| Trajectory evaluation | Check that a run called the expected tools in the expected order. | **Not used.** | — | A few "golden runs" per system, checked in tests and before release. | Off. | Golden runs and a judge. | 4 |
| Functional API (`entrypoint`, `task`) | Another way to write a workflow, without drawing a graph. | **Not used.** | — | Out of scope. The LangGraph docs prefer the graph API for new work. | — | — | — |
| `DeltaChannel` | Saves only the changes of a growing list, to keep checkpoints small. | **Not used.** Whether it is usable in the JavaScript version was not confirmed. | — | Not planned. Storing results by reference removes most of the growth. | — | — | — |

## Sources

All from the research of 2026-11-19 (`DOCS` = `https://docs.langchain.com/oss/javascript`).

- Graph model: `DOCS/langgraph/graph-api`, `DOCS/langgraph/graph-api-state`, `DOCS/langgraph/graph-api-control-flow`, `DOCS/langgraph/graph-api-send-command`
- Agents and middleware: `DOCS/langchain/agents`, `DOCS/langchain/middleware/overview`, `DOCS/langchain/middleware/built-in`, `DOCS/langchain/tools`, `DOCS/langchain/models`, `DOCS/langchain/structured-output`, `DOCS/langchain/multi-agent/index`, `DOCS/langchain/multi-agent/handoffs`, `DOCS/langgraph/workflows-agents`, `DOCS/langgraph/use-subgraphs`
- Saving state and memory: `DOCS/langgraph/persistence`, `DOCS/langgraph/checkpointers`, `DOCS/langgraph/functional-api`, `DOCS/langgraph/add-memory`, `DOCS/langgraph/stores`, `DOCS/langgraph/use-time-travel`
- People in the loop: `DOCS/langgraph/interrupts`, `DOCS/langchain/human-in-the-loop`
- Reliability: `DOCS/langgraph/fault-tolerance`, `DOCS/langgraph/graph-api-nodes`
- Live progress and tracing: `DOCS/langgraph/streaming`, `DOCS/langgraph/event-streaming`, `DOCS/langgraph/observability`, https://langfuse.com/integrations/frameworks/langchain
- Tests: `DOCS/langgraph/test`, `DOCS/langchain/test/unit-testing`, `DOCS/langchain/test/evals`
- Versions and changes: `DOCS/migrate/langgraph-v1`, `DOCS/releases/langgraph-v1`, `DOCS/releases/changelog`, https://github.com/langchain-ai/langgraphjs/releases, https://unpkg.com/@langchain/langgraph@1.7.4/dist/index.d.ts, https://unpkg.com/@langchain/langgraph-checkpoint-postgres@1.1.3/README.md
- Checkpoint growth: https://github.com/langchain-ai/langgraphjs/issues/1138
- Tool calling with open-weight models: https://docs.vllm.ai/en/latest/features/tool_calling/

Points the research could not confirm: the default durability mode; whether `DeltaChannel` is usable
in JavaScript; the default of `ToolNode`'s error option; whether `tool_choice: "required"` passes
through the gateway to the two models in use.
