# OpenMetadata — catalog & lineage

**What it is:** OpenMetadata (Apache 2.0) — the data **catalog + lineage** (what data exists,
who owns it, how it flows), with OpenSearch as its search backend and CloudNativePG for
metadata. **Off by default locally** (~2.5 GB); on for STACKIT.

## Enable it
Toggle on in the Admin Console, or `openmetadata.enabled: true` + `helm upgrade`. Give it a
minute (JVM + migrations + search-index bootstrap).

## Access (UI)
```bash
kubectl -n agentic-os port-forward svc/openmetadata 8585:8585
# http://localhost:8585
```
**Login:** `admin@open-metadata.org` / `admin` (basic auth, dev keys).

## Bot token for the OS Catalog
The OS UI Catalog unions OpenMetadata entries only when `OPENMETADATA_JWT` is set
(from the `os-ui-openmetadata` Secret); without it, OM is skipped honestly. Mint
the token from OM itself (admin login → ingestion-bot → auth-mechanism JWT):
```bash
OM=https://openmetadata.agentic.datamasterclass.com   # or the port-forward URL
# 1. admin JWT (password is base64-encoded per the OM login API)
ADMIN_JWT=$(curl -s -X POST "$OM/api/v1/users/login" -H 'Content-Type: application/json' \
  -d '{"email":"admin@open-metadata.org","password":"'"$(printf admin | base64)"'"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])')
# 2. ingestion-bot's bot user id
BOT_ID=$(curl -s -H "Authorization: Bearer $ADMIN_JWT" "$OM/api/v1/bots/name/ingestion-bot" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["botUser"]["id"])')
# 3. REGENERATE the bot's long-lived JWT. IMPORTANT: the JWT seeded into the OM
#    database can be signed by a keypair that no longer matches the running server's
#    signing keys — reusing it 401s "Invalid token". Always regenerate so the token
#    is signed by the LIVE keys:
BOT_JWT=$(curl -s -X PUT -H "Authorization: Bearer $ADMIN_JWT" -H 'Content-Type: application/json' \
  "$OM/api/v1/users/generateToken/$BOT_ID" -d '{"JWTTokenExpiry":"Unlimited"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["JWTToken"])')
# 4. hand it to the OS UI (Secret only — never commit it)
kubectl -n agentic-os create secret generic os-ui-openmetadata \
  --from-literal=OPENMETADATA_JWT="$BOT_JWT" --dry-run=client -o yaml | kubectl apply -f -
kubectl -n agentic-os rollout restart deploy/os-ui
```

## Populate the catalog — native ingestion (Trino/Iceberg + dbt + lineage)
OM ships **empty**: nothing crawls the OS data plane until you turn on ingestion, so the
Catalog shows "connected · 0 tables". We run OM's **own** ingestion framework (the
`openmetadata/ingestion` image executing `metadata ingest`) as a **K8s CronJob** — the same
workflow Airflow would run, just K8s-scheduled (there is no Airflow: `pipelineServiceClientConfig`
is disabled). One run ingests every `iceberg` schema/table/column into the OM Database Service
named `trino` (matching `OPENMETADATA_SERVICE`, so Catalog deep links resolve), plus optional
dbt models and query-log lineage.

Enable it (needs a **valid** bot JWT in `os-ui-openmetadata` — mint a FRESH one per the
recipe above; a stale DB-seeded token 401s):
```yaml
openmetadata:
  ingestion:
    enabled: true            # renders the CronJob (schedule "17 * * * *", hourly)
    dbt:
      enabled: true          # optional: needs dbt artifacts in S3 (below)
    lineage:
      enabled: true          # query-log table→table lineage (a second pass)
```
`helm upgrade …`, then trigger the first run immediately instead of waiting for the cron:
```bash
kubectl -n agentic-os create job --from=cronjob/openmetadata-trino-ingestion om-ingest-now
kubectl -n agentic-os logs -f job/om-ingest-now
# verify: OM /api/v1/tables now lists the iceberg gold marts
```

**dbt ingestion** reads `target/manifest.json` + `target/catalog.json`. The `dbt-build` Job
already runs `dbt docs generate` but writes to ephemeral storage — publish the two artifacts to
S3 (bucket `dbt`, prefix `artifacts/`) at the end of that Job so the OM `dbtConfigSource` can
read them, e.g. append to the dbt-build args:
```bash
aws --endpoint-url "$S3_ENDPOINT" s3 cp /opt/dbt/project/target/manifest.json s3://dbt/artifacts/manifest.json
aws --endpoint-url "$S3_ENDPOINT" s3 cp /opt/dbt/project/target/catalog.json  s3://dbt/artifacts/catalog.json
```
(Or set `openmetadata.ingestion.dbt.configType: local` and share the target dir via a PVC.)

## FAQ
**Q: Why off locally?** It's the heaviest single component (JVM ~2–3 GB). Build-and-toggle.
**Q: Airflow ingestion?** Disabled locally; metadata crawls run as K8s Jobs (the ingestion
CronJob above) in production.
