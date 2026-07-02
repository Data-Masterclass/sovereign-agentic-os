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
**Q: Persistence?** In-memory locally (a restart re-bootstraps). Durable deploys (STACKIT) set
`polaris.persistenceType: relational-jdbc` against the bundled `polaris` Postgres DB on `pg-rw`
(itself PVC-backed) — catalog metadata (the `lakehouse` warehouse + namespaces + tables) then
survives a pod restart. A `bootstrap` initContainer (the Polaris admin tool) creates the schema +
realm root once before the server starts.
**Q: Why two catalog paths?** See the query-tool doc — the SeaweedFS/MinIO local stand-in has
no STS for credential vending, so reads/writes use static-cred FileIO via the SQL catalog.
