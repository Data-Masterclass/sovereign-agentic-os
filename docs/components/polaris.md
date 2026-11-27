# Polaris — Iceberg REST catalog

**What it is:** Apache Polaris (Apache 2.0) — the **Iceberg REST catalog** for the lakehouse.
Manages table metadata; data files live on object storage (MinIO locally / STACKIT Object
Storage in prod). Deployed as the production catalog service.

## Access (API)
```bash
kubectl -n agentic-os port-forward svc/polaris 8181:8181
# health: curl http://localhost:8181/q/health   (management port 8182)
```
**Auth:** OAuth2 client-credentials, root `root` / `polaris-local-dev-secret`:
```bash
curl http://localhost:8181/api/catalog/v1/oauth/tokens \
  -d grant_type=client_credentials -d client_id=root -d client_secret=polaris-local-dev-secret \
  -d scope=PRINCIPAL_ROLE:ALL
```

## How it fits
- **Central Trino** reads/writes/maintains Iceberg tables through the Polaris REST catalog (OAuth2).
  Locally Trino uses static S3 creds (Polaris S3 credential vending needs AWS STS, absent locally).
- On STACKIT (S3 with STS), Polaris vends scoped credentials to clients directly (vended-credentials).

## FAQ
**Q: Persistence?** `relational-jdbc` by default, on every profile: the catalog metadata (the
`lakehouse` warehouse, its namespaces and tables) lives in the bundled `polaris` Postgres DB on `pg-rw`
(itself PVC-backed) and survives a Polaris restart. A `bootstrap` initContainer (the Polaris admin tool)
creates the schema + realm root once before the server starts. `in-memory` is an opt-in for throwaway
renders only: every restart, an OOM kill included, loses the catalog (a pilot install lost `lakehouse`
mid-install that way). Production has run `relational-jdbc` all along.
**Q: Memory?** The image's launcher (`run-java.sh`) sizes the heap as a percentage of the container limit,
80 % by default. Polaris' non-heap is about 300Mi RSS (production, 2026-11-27: RSS 497Mi with 85Mi heap
used), so 80 % of a 768Mi limit overran it and the container was OOM-killed. The chart sets
`JAVA_MAX_MEM_RATIO` from `polaris.jvm.maxRamPercentage` (default 50, allowed 10–90) on the server and on the
bootstrap admin tool: 768Mi → 384Mi heap (verified: `-XX:MaxRAMPercentage=50.0`, `MaxHeapSize=402653184`).
Limits: 1Gi chart default (production), 768Mi on the laptop and dev overlays.
**Q: A hook failed with "Unable to find warehouse lakehouse"?** See
[`docs/runbooks/failed-install-hooks.md`](../runbooks/failed-install-hooks.md).
**Q: Why two catalog paths?** See the query-tool doc — the SeaweedFS/MinIO local stand-in has
no STS for credential vending, so reads/writes use static-cred FileIO via the SQL catalog.
