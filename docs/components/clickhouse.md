# ClickHouse — analytics store

**What it is:** ClickHouse (Apache 2.0) — Langfuse v3's **analytics backend** (fast trace
aggregation). Single node locally.

## Access (HTTP/native, no UI)
```bash
kubectl -n agentic-os exec deploy/clickhouse -- \
  clickhouse-client --user langfuse --password clickhouse-local-dev \
  --query "SELECT count() FROM system.tables WHERE database='langfuse'"
```
**Login:** `langfuse` / `clickhouse-local-dev`. HTTP on 8123, native on 9000.

## FAQ
**Q: What's in it?** Langfuse's trace/observation analytics tables (the metadata is in Postgres).
**Q: Turning it off?** Langfuse v3 needs it for analytics; turning it off breaks Langfuse.
