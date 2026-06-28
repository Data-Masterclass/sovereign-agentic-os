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

## FAQ
**Q: Why off locally?** It's the heaviest single component (JVM ~2–3 GB). Build-and-toggle.
**Q: Airflow ingestion?** Disabled locally; metadata crawls run as K8s Jobs in production.
