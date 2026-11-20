# Trino

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`.

- **Licence:** Apache-2.0
- **Source:** https://github.com/trinodb/trino
- **Pinned as:** Image `trinodb/trino:476` (`charts/sovereign-agentic-os/values.yaml` `trino.image.tag`; the harness and CI read the pin from there)
- **Docs for this pin:** https://trino.io/docs/476/ — resource groups https://trino.io/docs/476/admin/resource-groups.html, session-property managers https://trino.io/docs/476/admin/session-property-managers.html, client protocol https://trino.io/docs/476/develop/client-protocol.html, OPA access control https://trino.io/docs/476/security/opa-access-control.html

**Why the OS ships it:** SQL over the Iceberg lakehouse for the Data and Metrics tabs.

The deployment that uses this pin lives in the chart
(`charts/sovereign-agentic-os/templates/`); any glue we wrote belongs there or in the
owning tab, never here.

## Proof harness

`tests/lakehouse/` (WP-13, design 06 §7.1) runs this pin with the chart's own config, beside the
chart's Polaris (on Postgres 17), OPA and MinIO: `bash tests/lakehouse/up.sh`, then
`node --test --test-concurrency=1 tests/lakehouse/*.int.test.mjs`. CI job `test-lakehouse`.
Another Trino tag can be tried with `bash tests/lakehouse/up.sh --set trino.image.tag=<n>`.

## Results recorded at WP-13 (Trino 476 + Polaris 1.1.0-incubating)

These come from executed tests in `tests/lakehouse/`; see the CI run of the WP-13 PR.

| Question | Result | Test |
|---|---|---|
| Does a `source` selector with a named capture route per domain and per user on the file manager? | **Yes.** `os-ui/<d>/<surface>` → `resource_group_id` `global.domains.<d>.<user>`; an e-mail uid keeps its dots inside its segment; the third concurrent query of a user is `QUEUED`; a domain at 8 running queues a new user while another domain runs. | `limits.int.test.mjs` |
| Do file session-property defaults apply per group on 476? | **Yes.** QueryInfo shows `query_max_run_time=60s`, `query_max_execution_time=45s`, `query_max_scan_physical_bytes=20GB` for a domain read and `2h` for `global.system`. | `limits.int.test.mjs` |
| Does npm `trino-client` 0.2.9 send `Authorization`, `X-Trino-User`, `X-Trino-Source`? (10 competing-code 21) | **Yes.** `BasicAuth` → `Authorization: Basic …`; a per-query `user` overrides `X-Trino-User` on the POST; `source` → `X-Trino-Source`; client tags through `extraHeaders`. Trino's QueryInfo shows the same user, source and tags. | `client.int.test.mjs` |
| Is a `trino-client` `Client` safe to share between callers? | **No.** `Client.request()` writes `X-Trino-Set-Session` (and catalog, schema, prepared statements) back onto the shared client config, so the next query of the same `Client` carries the previous caller's session. | `client.int.test.mjs` |
| Cross-namespace `ALTER TABLE … RENAME TO` on the pinned pair (10 F16) | **Supported.** `ALTER TABLE iceberg.a.po RENAME TO iceberg.b.po` keeps the rows, the identical snapshot list and `FOR VERSION AS OF` time travel; the old name is gone. The `register_table` fallback of 10 F16 is not needed. | `iceberg.int.test.mjs` |
| Iceberg tag DDL (06 §5.6, PR #26050) | **Not available on 476.** `ALTER TABLE … EXECUTE create_tag` → "Table procedure not registered"; `ALTER TABLE … CREATE TAG` and `CREATE BRANCH` are syntax errors. `"t$refs"` is readable. No 477–484 release note names tag-creation DDL (477 adds branch management). Tags stay with PyIceberg behind `decide()` (06 §5.6) unless a later pin adds the DDL. | `iceberg.int.test.mjs` |
| Dataset versions on 476 (WP-37, 06 §5.6) | **Native.** `"t$snapshots"` lists the versions (ids cast to `varchar`, they exceed 2^53); `"t$refs"` lists tags and branches; `FOR VERSION AS OF <id> \| '<tag>' \| '<branch>'` reads one; `EXCEPT ALL` between two such reads is the data diff; `ALTER TABLE … EXECUTE rollback_to_snapshot(<id>)` restores. A tag or branch is committed with PyIceberg `manage_snapshots().create_tag/create_branch` (data-runner `/refs`, https://py.iceberg.apache.org/api/#snapshot-management) and is then visible to plain Trino. `expire_snapshots` keeps every snapshot a ref points to and drops untagged ones (`iceberg.expire-snapshots.min-retention` lowered to `0s` in the harness only). | `os-ui/tabs/data/lib/dataset-versions.trino.test.ts` |

## Client choice (06 §5.3, 10 competing-code 21) — settled

Use npm **`trino-client`** (Apache-2.0; https://github.com/trinodb/trino-js-client) when os-ui talks
to Trino directly (WP-36, after the query-tool is retired). It sends every header the design
needs. Two rules follow from the results above:

1. **One `Trino.create()` per statement, never a shared instance.** The shared header state would
   otherwise carry one user's session into another user's query.
2. Cancel with the protocol's `DELETE nextUri`; the client's `cancel(queryId)` calls
   `DELETE /v1/query/{id}`, which is the kill endpoint and needs the kill permission.

Its one runtime dependency is `axios` (MIT). The ≤150-line protocol client fallback is not needed.
Until WP-36, os-ui keeps going through the query-tool, which passes os-ui's `source` and client
tags to Trino unchanged (`images/extensions/query-tool/execute_guard.py` `scheduling`).

## Upgrade notes read at WP-13 (477 … 484)

Release notes https://trino.io/docs/current/release/release-477.html … release-484.html. Items
that touch this chart's config:

- **484:** the Docker image moves to a Red Hat hardened base without the `run-trino` script; a
  custom `node.properties` must set `node.id=${ENV:HOSTNAME}`. `$snapshots`, `$history` and
  `$metadata_log_entries` return `timestamp with time zone` in UTC. User names keep their case in
  `GRANT`/`REVOKE`/`SET AUTHORIZATION`/`CREATE SCHEMA`. Fixes a failure when a session-property
  manager sets a default (#31281).
- **484 docs** name the native S3 switch `fs.s3.enabled`; the chart sets `fs.native-s3.enabled`.
- **481:** legacy (Hadoop) object storage removed; the chart already uses the native S3 file system.
- **482:** `$files.lower_bounds` / `upper_bounds` change type; `char`/`varchar` coercion reversed.
- **479:** JDK 25 (inside the image). **477:** decimal arithmetic precision inference changes.
- No change to resource groups, the file session-property manager or the OPA plugin config
  that this chart uses (477 adds physical-scan tracking; 479 adds a `queryText` selector; 484
  adds OPA extra-credential forwarding).

## SQL error classes and dialect hints (os-ui `core/mcp/trino-sql-error.ts`)

- Error names come from Trino's `StandardErrorCode`, reported in the client protocol as
  `errorName` / `errorType` (https://trino.io/docs/476/develop/client-protocol.html). The
  query-tool forwards the trino-python-client's `TrinoUserError(type=…, name=…, message=…)` text
  unchanged; os-ui types `FUNCTION_NOT_FOUND`, `FUNCTION_NOT_AGGREGATE`, `SYNTAX_ERROR`,
  `COLUMN_NOT_FOUND`, `TABLE_NOT_FOUND` and `SCHEMA_NOT_FOUND` (type `USER_ERROR`) as `sql_error`.
- Functions the hints name, all in Trino 476: `listagg(x, sep) WITHIN GROUP (ORDER BY …)`
  (https://trino.io/docs/476/functions/aggregate.html#listagg), `array_agg` and `array_join`
  (https://trino.io/docs/476/functions/array.html), `SHOW FUNCTIONS`.
- Proven on the chart's Trino 476 by `os-ui/core/mcp/trino-sql-error.trino.test.ts` (CI job
  `test-lakehouse`).
