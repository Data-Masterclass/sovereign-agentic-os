# Known defects of the agent engine

This page lists what is known to be wrong with how agents are built and run today. Each entry says
what goes wrong in plain words, where the evidence is, how bad it is, whether a fix exists, and
which phase of [`plan.md`](plan.md) fixes it.

Verified against commit `b47e2cd5` (main, 2026-11-19). Paths are relative to `os-ui/` unless they
start with `charts/`, `docs/` or `values`. `build-graph.ts` means
`tabs/agents/lib/engine/build-graph.ts`. `runtime.ts` means `core/runtime/runtime.ts`.

## How sure are we?

| Level | Meaning |
|---|---|
| **Code** | Read in the code at the lines given. Not executed. |
| **Live** | Seen on the production system on 2026-11-19. |
| **Suspected** | Follows from the code or the research, but nobody has shown it happen. |

"Live" entries were reported by the investigation of 2026-11-19. They were not re-run for this page.

## Status words

| Status | Meaning |
|---|---|
| open | No fix exists. |
| fix in progress | A pull request is open. It is **not merged**. The PR number is given. What each PR really changes was taken from its title, not from a review. |
| fixed in <version> | Shipped. (No entry has this status yet.) |

---

Entries are ranked. The groups are in order of urgency, and inside a group the most serious entry
comes first. The numbers (F0 to F19, S1 to S7) are the ones used in the code trace of 2026-11-19, so
they are not in numeric order here. Entries starting with L were added from the live checks and the
gateway research.

## Group 1: security and governance

| # | What goes wrong | Evidence | Level | Severity | Status | Phase |
|---|---|---|---|---|---|---|
| L1 | **The gateway is reachable from the internet and is out of date.** LiteLLM has its own public hostname with only its own key check in front. The deployed version 1.90.0 is covered by four published security advisories (one medium, two high, one critical titled "on Enterprise proxy"). | `charts/sovereign-agentic-os/templates/base/ingress.yaml:31-39` (the route exists when a hostname is set); `charts/sovereign-agentic-os/Chart.yaml:52-55`; advisories GHSA-3cv6-jpf6-8222, GHSA-g5ff-637f-6q2m, GHSA-2rwg-2wh4-7c4f, GHSA-w4c7-34wj-hqm8 | Live | Critical | open (owner decision 2 pending) | 0 |
| F3 | **A system's gateway key can be guessed.** Its value is `sk-os-` followed by the system id. Anyone who knows a system id and can reach the gateway (see L1) holds a working key. | `tabs/agents/lib/build/live-clients.ts:95-106` | Code + Live | High | open | 0 |
| F6 | **Resource grants are not enforced when an agent runs.** The list of datasets, documents, folders and connections a team "may use" is only text in the prompt. The tool executor checks the tool's name and nothing else. The prompt tells the model other items are "DENIED", which is not true. The agent can reach whatever the person running it can reach. A Files folder grant has no effect at all. The access level per grant and three of the four safety presets do nothing at run time. | `tabs/agents/lib/build/os-tools.ts:613-642`, `:149-151`, `:238`; `tabs/agents/lib/build/agentic-graph-server.ts:176-191`; `tabs/agents/lib/build/hold.ts:230-253` | Code + Live | High | open | 0 |
| F4 | **The system's own key is usually not the key that is used.** Its value is kept in the memory of the web process that ran Build. After a restart, and always in the worker, the value is missing and the shared key is used without any notice. Production runs in the worker, so per-system budgets and spend separation do not hold there, while Build shows the key as registered. | `core/infra/secrets.ts:21-40`, `:62-64`; `core/infra/litellm-credential.ts:108-111` | Code (worker mode: Live) | High | open | 0 |
| F16 | **Content that should be redacted reaches Langfuse twice over.** The gateway logs the full prompt and reply of every call into the same trace where the OS logs a redacted record. A second span per tool call stores the full arguments, even at the strict level. | `charts/sovereign-agentic-os/values.yaml:519-524`; `runtime.ts:196-202`; `tabs/agents/lib/build/os-tools.ts:726-740`; `core/infra/agent-governed.ts:329-354` | Code + Live | High | open | 0 (gateway logging off), 3 (one record per call) |
| L2 | **No salt key is set for the gateway.** The master key is therefore also the key that encrypts model credentials in the gateway's database, so it cannot be changed safely. | no `LITELLM_SALT_KEY` anywhere in `charts/` or `values.stackit-managed.yaml` | Code | Medium | open | 0 |
| L3 | **Two key schemes exist.** Build creates `os-<systemId>`. The admin reconcile creates `agent-<id>` with no budget. Runs use neither reliably. | `tabs/agents/lib/build/live.ts:193-230`; `tabs/admin/lib/litellm-reconcile.ts:71`, `:96-104` | Code | Medium | open | 0 |

## Group 2: runs that fail or go wrong

| # | What goes wrong | Evidence | Level | Severity | Status | Phase |
|---|---|---|---|---|---|---|
| F0 | **A team accepted from "Proposed team" cannot be built or run.** The proposer writes every hand-off condition as `<role> complete`. The condition reader rejects that text as a syntax error. | `tabs/agents/lib/assistant.ts:230`, `:80`; `tabs/agents/lib/engine/when.ts:150`; `build-graph.ts:664-672` | Code | High | open | 0 |
| F1 | **A failed agent does not stop the team.** When the act step fails, the engine says "end the run", but a second routing rule on the same step sends the run on to the next agent. The following agents spend tokens on a run that is already lost. A failure in the plan step does stop the run. | `build-graph.ts:748-751`, `:1203-1206`, `:1073-1144` | Code + Live (a failed first agent handed off to the second) | High | fix in progress (PR #91) | 0 |
| F2 | **One "too many requests" reply from the gateway fails the agent.** The OS tries each model call once. It does not wait and does not try again. | `runtime.ts:224-232` | Code + Live | High | fix in progress (PR #91) | 0 |
| S5 | **Normal runs hit the tokens-per-minute limit.** The shared key allows 200,000 tokens per minute for everyone. A real two-agent invoice run used about 185,000 tokens in ten calls and failed on that limit. | `charts/sovereign-agentic-os/values.yaml:402-405` | Live (was "suspected" in the trace) | High | fix in progress (PR #88 limits, PR #91 smaller prompts) | 0, 1 |
| F5 | **Budgets never reset, and a system key's limits can never be changed.** 5 USD for the lifetime of the key, on the shared key and on each system key. Once it is used up, that key stops for good. Rebuild does nothing to an existing key, so new models are not added either. | `tabs/agents/lib/build/live.ts:82-87`, `:197-198`; `charts/sovereign-agentic-os/values.yaml:390-393` | Code + Live | High | fix in progress (PR #92) | 0 |
| F10 | **Broken tool arguments are silently replaced by nothing.** If the model's arguments are not valid JSON, the tool is called with empty arguments. A reply that was cut off at the length limit is not noticed. An empty reply is recorded as a success and the next agent starts. | `runtime.ts:291-299`, `:322-343`; `build-graph.ts:866-869`, `:875` | Code | High | open | 0 |
| F8 | **A document read by one agent does not reach the next.** At hand-off, any text result over about 2,000 characters is cut to its first 800 and last 800 characters. The next agent is then told not to read the source again. | `tabs/agents/lib/build/agentic-graph.ts:319-335`, `:292-297`; `core/infra/context/context-assembler.ts:75-79`, `:147-152` | Code | High for teams that read files or knowledge | open | 1 |
| F0b | **Nothing notices that a definition changed after Build.** Run and Evaluate stay open on an old green build. Name, visibility, domain and schedule are stored in two places that are never synchronised. | `tabs/agents/lib/store.ts:1048-1096`; `tabs/agents/ui/SimpleBuilder.tsx:200`; `tabs/agents/ui/SystemView.tsx:359-362` | Code | High | open | 4 |
| F14 | **The text fallback throws away work and triggers too easily.** Any 400 error that mentions "tool" or "function" makes the OS assume the model cannot call tools. It restarts the agent's conversation without the tool results gathered so far. | `runtime.ts:226-228`; `build-graph.ts:861-864` | Code | Medium | open | 2 |
| F15 | **Errors are swallowed.** Several failures are caught and ignored: the "best answer" call at the step cap, writes to the event table, every Langfuse call, checkpoint notes, the "last run" record. A run that ends because an agent failed is stored as `done`. | `build-graph.ts:838-840`; `tabs/agents/lib/engine/jobs.ts:459-461`; `tabs/agents/lib/engine/observe.ts:211-217`; `tabs/agents/lib/build/run-service.ts:282`, `:293`, `:301`; `tabs/agents/lib/build/run-jobs-server.ts:305-330` | Code | Medium | open | 2 |

## Group 3: cost and speed

| # | What goes wrong | Evidence | Level | Severity | Status | Phase |
|---|---|---|---|---|---|---|
| F9 | **Every tool result is sent again on every later call.** Up to 5,000 tokens per result, never summarised, trimmed only at about 118,880 tokens. The defaults allow 100 tool rounds per agent and 400 steps per run. | `build-graph.ts:870-876`, `:971-974`; `core/runtime/agentic.ts:374-434`; `core/kernel/config.ts:377`, `:383` | Code | Medium | open | 1 |
| F7 | **Tool descriptions are sent three times, and the tool list is wrong for narrowed agents.** Each act call carries every tool description three times. The opening list shows the whole system's tools to every agent and calls it "your COMPLETE toolset". A fixed sentence about "files committed, preview URL, deploy-review status" goes to every team. | `tabs/agents/lib/build/agentic-graph-server.ts:344`; `tabs/agents/lib/build/os-tools.ts:523-536`; `core/runtime/agentic.ts:307-325` | Code | Medium | fix in progress (PR #91, "prompt diet") | 1 |
| F11 | **Every agent visit starts with a separate planning call on the most expensive model.** It ignores the agent's own model setting and roughly doubles the calls of a simple agent. | `build-graph.ts:782-787`; `tabs/agents/lib/build/agentic-graph-server.ts:358` | Code | Medium | open | 1 |
| F17 | **Only one run at a time.** One worker, one job at a time. The live feed reads the database every 400 ms for each open view. | `tabs/agents/lib/engine/worker-loop.ts:176-180`; `charts/sovereign-agentic-os/templates/os-ui-worker.yaml:40`; `app/api/agents/systems/[id]/run/route.ts:173-175` | Code (one worker: Live) | Low to medium | open | 2 |

## Group 4: things that look like they work and do not

| # | What goes wrong | Evidence | Level | Severity | Status | Phase |
|---|---|---|---|---|---|---|
| F13 | **Build checks things a run does not use.** The policy entry it writes is never read by a run. The "allowed tools" on the key are not enforced by anything. The Langfuse row counts entries in one process's memory. A run does not need a green build. A build through the MCP tool is not saved. | `tabs/agents/lib/build/os-tools.ts:35-43`; `tabs/agents/lib/build/live.ts:161-191`, `:255-268`; `core/mcp/agent-write-tools.ts:109-114` | Code | Medium | fix in progress in part (PR #92, "honest build rows") | 0, 4 |
| F12 | **Model settings that do nothing.** "Routing overrides" in Developer mode and an agent's role line have no effect on a run. Build's gateway check tests a table inside the OS, not the gateway. "Auto" model choice flips to the expensive model when the instructions contain a word like "plan" or "reason" anywhere. | `tabs/agents/ui/GrantsRouting.tsx:373-392`; `tabs/agents/lib/build/live.ts:101-108`, `:222-228`; `tabs/agents/lib/routing.ts:267-290` | Code | Medium | open | 4 |
| F18 | **The agent loop exists twice.** The engine and the tab assistants each have their own copy with different safety rules. | `core/runtime/agentic.ts:443-915`; `build-graph.ts:820-1070` | Code | Low | open | 2 |
| F19 | **Documents that describe something else than the code.** Listed in the next section. | see below | Code | Low | partly fixed in this pull request | — |

## Stale statements in other documents (F19)

| Where | What it says | What the code does | Status |
|---|---|---|---|
| `docs/components/litellm.md` ("Rejections are typed") | Any other 4xx on a model call becomes a typed `GatewayRejectedError`. | On the run path and the assistant path it becomes a plain error. Only the two embedders throw the typed error (`runtime.ts:224-232`; `core/runtime/complete.ts:126-127`; `tabs/knowledge/lib/embed.ts:96`; `tabs/files/lib/embed.ts:109`). | corrected in this pull request |
| `docs/components/litellm.md` ("read from the secrets store") | A system's key is read from the secrets store by reference. | The "store" is a map in one process's memory (`core/infra/secrets.ts:21-40`). | corrected in this pull request |
| `os-ui/ARCHITECTURE.md` (checkpoint retention) | Retention is an open item. | A sweep exists (`tabs/agents/lib/engine/retention.ts`). | corrected in this pull request |
| `docs/components/langgraph.md` | Did not exist. | — | added in this pull request, as a pointer to this folder |
| `os-ui/ARCHITECTURE.md:407-410` | The system's own key is resolved "by reference". | True as written, but it leaves out that the value is lost on restart and in the worker. | not changed; see F4 here |
| `core/mcp/agent-write-tools.ts:121` (the description of the MCP tool `run_agent_system`) | Tool calls are "OPA `os-<systemId>` pre-gated". | The run path does not ask the policy service for that entry (`tabs/agents/lib/build/os-tools.ts:35-43`). | not changed: it is code, and this pull request is documentation only |
| `charts/sovereign-agentic-os/values.yaml:402` (comment) | "Per-key rate limits with graceful queueing". | The gateway refuses with HTTP 429. It does not queue. | not changed: chart file |
| `tabs/agents/lib/store.ts:28` (comment) | "durable file-backed record". | A map in memory with a best-effort copy in OpenSearch (`store.ts:271-315`). | not changed: code |
| `docs/superpowers/plans/2026-11-13-engine-rebuild.md:75` | "one subgraph per agent". | Four flat steps per agent in one graph. | not changed: a dated plan, kept as history |

## Suspected, not shown

| # | What might go wrong | Why we think so | What would settle it | Phase |
|---|---|---|---|---|
| S1 | With gateway fallbacks on, a system key that does not list the fallback model is refused instead of served by the fallback. | The shared key lists the fallback models explicitly; the research says key access is enforced on fallback targets. | One test call with a system key and a forced failure. | 0 |
| S2 | After a forced stop in the middle of several tool calls, the next request contains calls without results. Strict providers reject that, and the rejection text would trigger the text fallback (F14). | `build-graph.ts:1061-1064` | A scripted-model test. | 2 |
| S3 | Langfuse totals count each run's tokens twice. | Two generations per call both carry usage. | Compare one run's Langfuse total with the gateway's. | 3 |
| S4 | A write that was in progress when the worker crashed can run twice on resume. | The guard is saved only after the call returns (`build-graph.ts:992-1003`). | A crash test with a scripted tool. | 2 |
| S6 | A model without tool support silently has its tools dropped by the gateway and answers in prose. | `drop_params: true` (`charts/sovereign-agentic-os/values.yaml:525`). | One call per alias with a tool attached. | 0 |
| S7 | Build's Langfuse row and the Monitoring view do not see runs done by the worker. | They read a list kept in the web process's memory (`core/infra/agent-governed.ts:311-322`). | Run once in production and look at the Build row. | 4 |

(S5 moved to Group 2: it was seen live.)

## Open questions that affect the entries above

1. A step limit of 12 was seen on the live system. No default in the code or chart is 12. Which setting produces it is not known.
2. Which admin model-role overrides are set in production. They decide every model name used in a run.
3. Whether the STACKIT endpoint reports "cut off at the length limit" and how it treats forced tool calls for the two models in use.
4. Whether the deployed gateway counts a non-zero cost for the STACKIT aliases. If it counts zero, no budget can ever trigger, and F5 would be hidden rather than fixed.
5. Whether the tools themselves limit access to granted items anywhere. Only the agent executor was traced, not every tool. This matters for F6.
6. Real token counts. The trace estimates tokens as characters divided by four. The live run used about 20,000 tokens per call by the gateway's counter, which is more than that estimate predicts. It must be measured (see the benchmark in [`plan.md`](plan.md)).
7. Whether a timed run uses a pinned version of the definition. A comment says so (`tabs/agents/lib/build/scheduled.ts:120-123`); the executor reads the current record (`tabs/agents/lib/build/run-jobs-server.ts:285-286`).
