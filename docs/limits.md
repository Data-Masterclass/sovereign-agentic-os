# Limits register: what the OS shortens, and whether anyone is told

Every cap, limit, truncation and timeout in the server code that changes what a **user**, an
**agent** or a **model** sees. This file is kept by hand: the limits live next to the code they
guard, so a generated registry would have meant moving 60 constants and a large, risky diff.
Update the row whenever you add or change a limit.

**The rule:** a limit that an agent or a user would act on wrongly must be **told**, in two
places. The result carries an explicit marker the model reads ("showing 50 of 312; narrow with
folder= or search_files"), and the run, or the health signal, records a warning a person reads.

- **Told:** `yes` means the text or JSON the reader receives says so explicitly, with counts.
  `partly` means a bare flag or a trailing "…" with no count. `no` means silent.
- **Severity if silent:** `high` means an agent or a user would draw a wrong conclusion about
  completeness ("there are 9 invoices"). `medium` means the result is degraded but visible
  elsewhere. `low` means cosmetic or internal.
- **Status:** `fixed` means told since this register (PR "context never breaks silently"),
  with a test. `was told` means it already was. `open` means not fixed yet, with the reason.

Security and abuse limits (login rate limits, token lifetimes, upload and push sizes) are left
out on purpose.

Paths are relative to `os-ui/`.

## Agent engine: what a model request contains

| Limit | Value | Where | What it limits | When hit | Told? | Sev. | Status |
|---|---|---|---|---|---|---|---|
| Tool-result bound | 20,000 chars (`AGENT_TOOL_RESULT_MAX_CHARS`) | `tabs/agents/lib/engine/tool-result.ts:31` | One tool result entering the prompt | Cut by **rows** (per group for `{mine, domain, marketplace}` listings), else by characters | yes: `[truncated: showing 37 of 312 rows (mine 20 of 250, …)] <how to narrow>`, plus a run warning per agent and tool | high | **fixed**: grouped listings were cut mid-JSON by characters (the incident: 3 of 12 invoices hidden); no narrowing hint; no run warning |
| Tool-call deadline | 60 s (`AGENT_TOOL_CALL_TIMEOUT_MS`) | `tabs/agents/lib/engine/tool-result.ts:33` | Waiting for one tool | Typed `timeout` result; a write is then "unresolved" | yes | — | was told |
| History budget | model window − reserved output − 4% headroom (about 119k for 128k models) | `core/models/context-windows.ts:117`, `agentic-graph-server.ts:90` | All messages of one model request | Oldest turns compacted, then dropped (`budgetMessagesReport`, `core/runtime/agentic.ts`) | yes: `[Context note: N earlier messages were removed to fit the model's context window …]` in the system message, plus a run warning | high | **fixed**: was silent, and the budget did not count the **tool definitions** (about 4.7k tokens), so a request could pass the model window. A 12k-window test reached 13,294 |
| Fallback message budget | 24,000 tokens | `core/runtime/agentic.ts:342` | Same, when no model window is known | Same as above | yes (same note) | high | **fixed** (same code path) |
| Team hand-off budget | 40% of the input budget (default 6,000 tokens) | `tabs/agents/lib/build/agentic-graph.ts:463` | Earlier agents' outputs given to the next agent | Older outputs shortened to a summary line, the oldest dropped | yes: `## (hand-off note) N earlier agent outputs were shortened … do not read its absence as "they found nothing"` | high | **fixed** |
| Hand-off rows per result | 60 rows | `tabs/agents/lib/build/agentic-graph.ts:315` | Rows of one result in the hand-off | Compacted | yes: `…(N more rows)` | — | was told |
| Captured node input | 8,000 chars | `tabs/agents/lib/build/agentic-graph.ts:121` | Run-panel drill-down only | Cut | yes: `… [truncated N more chars]` | low | was told |
| Step caps | 100 per agent, 400 per run (`agentTeamNodeMaxSteps`/`agentTeamRunMaxSteps`); 6 single-agent | `core/kernel/config.ts:407,413`; `core/runtime/agentic.ts:186` | Tool rounds | One final synthesis | yes: "Reached the tool step limit (cap) …" and `budget.exhausted` | — | was told |
| Tool summary in the prompt | 120 chars | `tabs/agents/lib/build/tool-brief.ts:25` | Description in the ACT prompt | Shortened to one sentence | partly ("…"); the full schema still goes in `tools` | low | was told (by design) |
| Conversation window | last 20 turns | `core/runtime/turns.ts:33` | Prior chat turns in apps chat, agent run and software team | Older turns dropped | yes: `[N earlier turns of this conversation were omitted …]` on the oldest kept turn | medium | **fixed** |
| Assistant routes window | last 12 messages, 4,000 chars each | `core/runtime/turns.ts:41` (`readBoundedTurns`); used by the apps, agents and expose assistants | Same | Dropped / cut | yes: omitted count, plus `[…this message was cut at 4000 of N characters]` | medium | **fixed** (also 3 copies become 1) |
| Team planner granted-asset list | 40 names per kind | `tabs/agents/lib/propose-team.ts:118` | "the team may reference ONLY these granted assets" | Rest not named | yes: `…and N more that ARE granted` | high | **fixed**: the planner treated asset 41+ as not granted |
| Folder-grant budget | 50 items (`OS_FOLDER_GRANT_BUDGET`) | `core/kernel/config.ts:652`; `tabs/agents/lib/build/os-tools.ts` (`resolveFolderGrants`) | Data or knowledge items one folder grant gives a run | Only the first 50 are granted | yes: run warning `… this run was given only the first 50 of 80 datasets (the folder-grant budget)`, plus a server log. The agent sees the granted items only. | high | **fixed** (run warning). Files are checked live per call, so the budget never narrows files. |
| Description in agent listings | 140 chars | `tabs/agents/lib/build/agent-tool-results.ts:32` | A file's description | Shortened | partly ("…") | low | was told (by design) |
| Run-panel step fields | 4,000 / 240 chars | `tabs/agents/lib/build/run-service.ts:97` | UI drill-down and preview | Cut | yes `… [truncated]` / partly "…" | low | was told |
| Approval args | 4,000 chars | `tabs/agents/lib/engine/approvals-bridge.ts:25` | Args shown to an approver | Cut | yes: `_truncated: true` + preview | low | was told |
| Stored failure / checkpoint text | 2,000 chars | `tabs/agents/lib/engine/jobs.ts:228`; `tabs/agents/lib/store.ts:1245` | Stored messages | Cut | partly ("…") | low | open (cosmetic) |
| Run-event replay | 2,000 events | `tabs/agents/lib/engine/run-events.ts:44` | SSE replay on reattach | Oldest evicted | no | low | open: a reattached stream can miss its start; the run record itself is complete |
| Proposed agents | 8 | `tabs/agents/lib/assistant.ts:123` | Agents scaffolded from one proposal | Extras dropped | no | medium | open: needs a field on the scaffold response the builder shows (UI change) |

## Tool results: files, data, knowledge, metrics

| Limit | Value | Where | What it limits | When hit | Told? | Sev. | Status |
|---|---|---|---|---|---|---|---|
| `list_files` for an agent | grant-scoped, compact rows | `tabs/agents/lib/build/agent-tool-results.ts` | Files the agent is shown | An empty (or misspelt) folder grant listed 0 files | yes: `0 files in /Invoices (My files); the grant is empty. Say so in your answer …` | high | **fixed** (today's evidence: a grant resolving to 0 files read as "no invoices") |
| Wrong-case folder asked for | case-insensitive | `core/kernel/folders.ts`, `discovery-read-tools.ts` | `folder=` argument | — | — | — | was fixed earlier today; covered by a test here |
| Folder names hint | 40 folders | `core/kernel/folders.ts:108` (`distinctFolderList`) | `availableFolders` when a folder is missing | Rest not listed | yes: `moreFolders: N` and "(the first 40; N more exist)" | medium | **fixed** |
| `get_file` text | 8,000 chars per page | `tabs/admin/mcp/discovery-waveb-tools.ts:63` | File text | Paged | yes: `textNote: "… Call get_file again with offset=8000 …"`, plus `nextOffset` | high | **fixed**: said "Read the rest in the tab UI", which an agent cannot do; a new `offset` argument reads the rest |
| `read_app_files` content | 24,000 chars per page | `tabs/admin/mcp/discovery-waveb-tools.ts:64` | App file content | Paged | yes (same as `get_file`) | medium | **fixed** |
| `search_files` top-k | 20 | `tabs/files/lib/store.ts:955` | Search hits | Top 20 | yes: `{ total, hits, note: "N files match; showing the top 20 of N …" }` | high | **fixed**. The result is now an object, not a bare array; grant filtering still applies. |
| `search_knowledge` k | default 6, max 20 | `tabs/knowledge/mcp/knowledge-search-tools.ts:29` | Hits | Top-k | partly: the agent sets `k`; no total | low | open: a total needs a count query in `retrieve.ts` |
| Not-granted tool | — | `tabs/agents/lib/build/os-tools.ts` | A call to a tool the system lacks | Refused | yes: "… is not granted to this system, so it was not run and nothing was read …" | high | **fixed** (was "Tool not available: list_files") |
| `query_data` rows | `QUERY_MAX_ROWS` (query-tool) | `core/infra/governed.ts`, `tabs/data/mcp/data-query-tools.ts` | SQL rows | Cut | yes: query-tool message, "⚠ TRUNCATED" first | — | was told |
| Data-tab Ask rows | query-tool limit; 50 rows / 200 chars to the summary | `tabs/data/lib/ask.ts:164,171` | Rows behind an Ask answer | Cut | yes: "The query hit the row limit of N: these are the first N rows only … Do not count or total them", plus `truncated` and `truncationNote` in the response | high | **fixed**: the flag was dropped, so "1000 rows total" could be stated for a clipped result. The 200-char cell cut is still unmarked (low, open). |
| `query_metric` rows | default 100 | `tabs/admin/mcp/discovery-read-tools.ts:87` | Metric rows | Cut, total withheld | yes | — | was told |
| `preview_metric` rows | default 20, max 100 | `tabs/metrics/mcp/metric-write-tools.ts:336` | Preview rows | Cut | yes: the same `rowLimitTruncation` message | medium | **fixed** |
| `profile_dataset` top values | over 40 columns: skipped | `tabs/admin/mcp/discovery-read-tools.ts:204` | Top-value statistics | Skipped | yes: `topValuesSkipped` | medium | **fixed** for the agent tool. The two UI routes (`app/api/data/datasets/[id]/profile`, `…/dq`) still only omit the field: open. |
| Live profile sample | 10,000 rows | `tabs/data/lib/profile.ts:102` | Statistics sample | Sampled | yes: "sampled, approximate" | — | was told |
| Data preview | 50 default / 200 max | `tabs/data/lib/preview.ts:22` | Preview rows | Cut | partly (`limit` echoed) | low | open |
| Ask chart | 100 rows / 12 pie slices | `tabs/data/lib/ask-chart.ts:54` | Plotted rows | Cut | yes (`plottedRows < totalRows`) | low | was told |
| Metric suggestion context | 6,000 tokens | `tabs/metrics/lib/suggest.ts:108` | Operating model, workflows, datasets | Shortened | yes: `(Context shortened to fit the prompt: N more context blocks omitted.)` | high | **fixed**: an oversized first block emptied the context, and the prompt then said "(no operating model or datasets are visible yet)", which was false |
| Software grant context | 3,000 / 500 tokens | `tabs/software/lib/grants-context.ts:40` | Grants in the builder prompt | Cut | yes | — | was told |
| Builder grounding | 6,000 / 1,200 chars, 5 sample rows | `tabs/software/lib/builder/grounding.ts:94` | Builder context | Cut | yes | low | was told |
| Knowledge retrieval (`retrieve` tool) | 4 hits, 2.5 s | `core/infra/agent-governed.ts:461` | Passages | — | yes | high | **fixed**: on zero hits **and** on a timeout it returned a fixed passage labelled "Discount Policy (Certified)". Now zero hits returns nothing, and an unreachable index returns the sample labelled "offline sample", never certified. |
| Evaluate criteria / classify text | 4,000 chars | `app/api/agents/systems/[id]/evaluate/route.ts:39`; `app/api/classify/route.ts:85` | Text sent to the judge / classifier | Cut | yes: `…[truncated to fit context]…` | medium | **fixed** |
| Engineering view files | 12 files | `core/engineering/repo.ts:56` | Files read for a panel | Rest not read | partly: `omitted: N` on the read | medium | **fixed** in the reader; the panels do not show it yet (open) |

## Connectors

| Limit | Value | Where | When hit | Told? | Sev. | Status |
|---|---|---|---|---|---|---|
| Connector page caps | Slack 5×100, GitHub 5×50, Gmail 4×25, Notion 5×25, Atlassian 5×50, Google Calendar 4×25, Outlook 4×25, single-page directories 25, Snowflake governance 50 rows, Salesforce search 200, OData 20/200 | `tabs/connections/lib/{slack,github,gmail,notion,atlassian,gcal,outlook,purview,snowflake-governance,salesforce}.ts`, `odata/client.ts` | Paging stops | yes: `truncated: true, returned: N, note: "Only the first N … the source holds more …"` | medium | **fixed** in the one shaper `connectorDone` (`tabs/connections/lib/store.ts:2133`, which replaces 16 copies). Single-page reads that never set `truncated` (the directories) are still partly told: open. |
| Slack channel history | 50 (max 100), one page | `tabs/connections/lib/slack.ts:208` | More messages | yes: `truncated` from `has_more` | high | **fixed** |
| Airflow task log | 8,000 chars | `tabs/connections/lib/airflow.ts:80` | Cut | partly (`truncated` flag) | low | open |

## Monitoring, runs, history

| Limit | Value | Where | When hit | Told? | Sev. | Status |
|---|---|---|---|---|---|---|
| `list_runs` | 25 default, 50 max | `core/mcp/monitoring-tools.ts:68` | A full page | yes: `hasMore` + note | medium | **fixed** |
| `get_agent_run` events | 50 default, 200 max | `core/mcp/discovery-base-tools.ts:58` | A full page | yes: `hasMore` (with `nextSeq`) | medium | **fixed** |
| `get_history` commits | 10 default, 100 max | `core/mcp/git-tools.ts:102` | A full page | partly | medium | open: needs the scan window's own "more" signal (`git-objects.ts`) |
| Git version / diff / subtree | 500 files, 4–8 MB, 400k cells | `core/infra/git-store.ts:1456` | Cut or refused | yes (`truncated`, `truncatedBy`, typed refusals) | — | was told |
| Files lineage ring | 500 edges | `tabs/files/lib/lineage.ts:36` | Oldest evicted | no | medium | open, **structural**: lineage needs durable storage |
| Knowledge links on save | 50 | `tabs/knowledge/lib/links.ts:22` | Extra links dropped | no | low | open |
| Reindex failure list | 50 | `core/kernel/reindex.ts:251` | Not listed | partly (counter keeps counting) | low | was told (count) |

## Stores and timeouts

| Limit | Value | Where | When hit | Told? | Sev. | Status |
|---|---|---|---|---|---|---|
| Store hydration caps | 500–5,000 records per store (`mirror.hydrate(N)`, 47 call sites) | `core/infra/os-mirror.ts:230` | Records past the cap are missing from that process: lists and searches over the store are incomplete | yes: `console.error("[os-mirror] <index>: loaded 2000 of 2500 records …")` and `/api/status` → `storeWarnings` | high | **fixed (interim)**. Structural fix: move the stores to a database with paged reads (the planned Postgres move). |
| Query-tool wait | 8 s | `core/infra/governed.ts:140` | Our wait ends; the query may still run | yes: "Could not reach query-tool within 8 s — it may be down, or the query is slow and still running" | medium | **fixed** (was "Could not reach query-tool") |
| Model call | 240 s (`LLM_CHAT_TIMEOUT_MS`) | `core/runtime/complete.ts:82` | Abort | partly (raw AbortError text) | low | open |
| Ask-OS chat turn | 90 s (`CHAT_TIMEOUT_MS`) | `app/api/assistant/chat/route.ts:32` | Never fires: its signal is not passed on | n/a (dead code) | medium | open, **decision**: wire it (turns that take 90–240 s today would then fail) or delete it |
| Agent chat | 90 s | `app/api/agent-chat/route.ts` | 504 with a reason | yes | — | was told |
| Connector HTTP timeouts | 6–60 s | connector clients | `{ ok:false, reason }` | yes | low | was told |

## Counts

- Rows in this register: **57** (one row can hold several values of one kind, such as the connector page caps).
- Already told before this PR: **19** (one of them, the wrong-case folder, was fixed earlier today).
- Silent or only partly told when this register was taken: **38**. Fixed in this PR: **27** (in 4 of them a follow-up part is still open, as the row says). Still open: **11**, each with its reason.
