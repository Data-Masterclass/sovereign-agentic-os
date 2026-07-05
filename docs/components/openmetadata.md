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
# 3. the bot's long-lived JWT (regenerate with PUT /api/v1/users/generateToken/{id}
#    body {"JWTTokenExpiry":"Unlimited"} if absent/expired)
BOT_JWT=$(curl -s -H "Authorization: Bearer $ADMIN_JWT" "$OM/api/v1/users/auth-mechanism/$BOT_ID" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["config"]["JWTToken"])')
# 4. hand it to the OS UI (Secret only — never commit it)
kubectl -n agentic-os create secret generic os-ui-openmetadata \
  --from-literal=OPENMETADATA_JWT="$BOT_JWT" --dry-run=client -o yaml | kubectl apply -f -
kubectl -n agentic-os rollout restart deploy/os-ui
```

## FAQ
**Q: Why off locally?** It's the heaviest single component (JVM ~2–3 GB). Build-and-toggle.
**Q: Airflow ingestion?** Disabled locally; metadata crawls run as K8s Jobs in production.
