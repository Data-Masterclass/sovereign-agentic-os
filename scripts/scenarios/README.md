# Live scenarios

A small, repeatable set of **real** scenarios that run against a live OS through its own MCP
door (`/api/mcp`), the same governed path an external AI client uses. Run them after every
deploy. Each run writes a JSON and a Markdown report: per step the tool, a summary of its
arguments, status, duration, response size and which assertions held.

| File | What it is |
|---|---|
| `run.mjs` | the CLI: loads scenarios, calls the endpoint, writes the report |
| `lib.mjs` | the pure parts: allowlists, path lookup, assertions, SQL guard (unit-tested) |
| `runner.test.mjs` | `node --test scripts/scenarios/runner.test.mjs` |
| `NN-*.json` | read-only scenarios (run by default) |
| `write/*.json` | sandbox write scenarios (`"requiresWrite": true`), never run by default |

## How to run

```sh
export OS_MCP_TOKEN=…            # an OS MCP bearer for the identity you want to test as; never commit it
export OS_MCP_URL=https://<host>/api/mcp
node scripts/scenarios/run.mjs --read-only                  # all read-only scenarios
node scripts/scenarios/run.mjs --only 02-files,04-data      # a subset
node scripts/scenarios/run.mjs --read-only --shape          # also print response SHAPES (keys, types, lengths; no values)
node scripts/scenarios/run.mjs --dry-run                    # check the allowlist and substitution, no calls
```

Reports go to `--out` (default: `$TMPDIR/os-scenarios`), never into the repo. Exit code 1 means
at least one scenario failed; 2 means the runner itself could not run.

The first request is `initialize`, which records the server's `serverInfo.version` in the report.

## Safety rules (enforced by the runner, not only by the server)

- **Read-only by default.** `lib.mjs` holds the runner's own allowlist (`READ_ONLY_TOOLS`). Any
  other tool is refused before anything is sent. `query_data` additionally needs one
  `SELECT`/`WITH` statement with `LIMIT <= 100` (or a single aggregate).
- **Never** tools (`NEVER_TOOLS`: approve, decide, promote, publish, go live, deploy, connection
  tests, re-index, sync, operating-manual edits) are refused in every mode.
- **One call at a time**, at least 1 s between call starts, at most 200 calls per invocation.
- **No content in reports.** A failed assertion reports a type and a size, never the value.
  `record` keeps numbers, booleans and short enum-like strings only.
- **Writes** need all of: `--allow-write`, `--sandbox-folder /_os-selftest`, a scenario marked
  `"requiresWrite": true` with a `sandboxDomain`; every folder argument and every folder in a
  committed `system.yaml` must sit inside the sandbox; no Domain scope; build/run/commit/retire
  only act on an object the same run created. Write scenarios need the owner's yes before
  anyone runs them. Every object a write step creates is listed under "Created by this run".
  The MCP door has no delete for files or agent systems today, so those are cleaned up by hand
  (see each write scenario's `cleanup` note).

## How to add a scenario

A scenario is a JSON file:

```json
{
  "id": "07-metrics", "title": "Metrics answer",
  "vars": { "match": "revenue" },
  "steps": [
    { "id": "list", "tool": "list_metrics", "save": { "ids": "mine[?name~=revenue].id" } },
    { "id": "get", "tool": "get_metric", "forEach": "ids", "max": 2, "args": { "metricId": "${item}" },
      "assert": [ { "path": "status", "op": "equals", "value": "live" } ],
      "record": { "dims": "dimensions" } }
  ]
}
```

- **Never hard-code ids** of production objects: look them up at run time (`save`, `forEach`).
  No production names, ids or content in this folder.
- Paths: `a.b[0].c`, `a.0.c`, `a[*].id`, `a[?name~=Invoice].id` (contains, case-insensitive),
  `a[?status=done]`, `a[?x!=y]`, `a.length`. A fan-out compares by count in `gte`/`lte`.
- Assertions (`op`): `exists` `absent` `nonEmpty` `equals` `notEquals` `allEqual` `gte` `lte`
  `contains` `containsAny` `notContains` `matches` `type` `containsAll` `anyGt` `allNonEmpty`
  `backtickedNamesIn`. Modifiers: `soft: true` (a miss is a WARN, e.g. merged but not yet
  deployed) and `when: { path, equals }`.
- Every step also asserts "no error code" (or `expectError`) and a timing budget: `budgetMs`, else
  the scenario's `readBudgetMs` (default 3000 ms).
- `requires: ["var"]` fails the step (or skips it with `optional: true`) when a variable is empty.
- `retry: { times, delayMs, until: [assertions] }` polls a read until it holds; every attempt
  is a real call and counts against the budget.
- `record` values: a path, or `{ "sum" | "span" | "distinct": path }`.
