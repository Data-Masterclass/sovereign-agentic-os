# MinIO — object storage

**What it is:** S3-compatible object storage (the local stand-in for STACKIT Object Storage).
Holds the **Iceberg lakehouse** (`lakehouse` bucket) and **Langfuse** event blobs (`langfuse`
bucket). (SeaweedFS is the air-gap option but proved unreliable for Iceberg on kind.)

## Access
```bash
kubectl -n agentic-os port-forward svc/minio 9001:9001     # web console
# http://localhost:9001
```
**Login:** `agentic-os-local` / `agentic-os-local-secret`  (also the S3 access key/secret)

## How to use it
- Browse buckets/objects in the console. S3 API is on port 9000 (`http://minio:9000`).
- Used by: Polaris/DuckDB (lakehouse data), Langfuse (blobs).

## FAQ
**Q: Turning it off?** It's core — Langfuse + the lakehouse depend on it. Leave it on.
**Q: AGPL?** MinIO is AGPL — used as a **local dev stand-in only**, never bundled/shipped. On
STACKIT you use real Object Storage (`objectStorage.mode: external`).
