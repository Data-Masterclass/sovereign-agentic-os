# PostgreSQL (CloudNativePG)

**What it is:** The infra database, managed by the **CloudNativePG** operator. One cluster
(`pg`) hosts multiple databases: `langfuse`, `litellm`, `dagster`, `warehouse` (dbt),
`polaris` (Iceberg catalog), `superset`. Continuous WAL backup + PITR in production.

## Access (no UI — psql)
```bash
kubectl -n agentic-os exec -it pg-1 -- psql -U postgres        # superuser
# or a specific DB/role:
kubectl -n agentic-os exec pg-1 -- psql -U postgres -d warehouse -c "\dt analytics.*"
```
Services: `pg-rw` (read-write), `pg-ro`, `pg-r`. Per-DB roles + dev passwords are in each
consumer's doc/values (e.g. warehouse: `warehouse` / `warehouse-local-dev`).

## FAQ
**Q: Why not toggleable from the console?** It's operator-managed (a CNPG `Cluster` CR, not a
Deployment) and half the stack depends on it. Manage via the chart, not by scaling.
**Q: Add a database?** Add an entry to `postgres.extraDatabases` (creates a role + Database CR).
**Q: Backups?** CloudNativePG does WAL archiving + PITR to object storage on STACKIT.
