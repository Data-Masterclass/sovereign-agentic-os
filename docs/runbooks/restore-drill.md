<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Restore drill — prove the backups restore

A backup that has never been restored is a hope, not a backup. Run this drill
after the first Velero backup, after any storage change, and before each
cohort. Everything restores into scratch targets — the live platform is never
touched. Budget ~45 minutes.

```bash
cd sovereign-os-stack && export KUBECONFIG="$PWD/deploy/kubeconfig.yaml"
```

## 1. Postgres (pg_dump tier)

Restore last night's dump into a throwaway Postgres and verify row counts.

```bash
# newest dump folder on MinIO
kubectl -n agentic-os port-forward svc/minio 9000:9000 &   # or use the console
AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
  aws --endpoint-url http://localhost:9000 s3 ls s3://lakehouse/backups/pg/
STAMP=<newest>
aws --endpoint-url http://localhost:9000 s3 cp --recursive \
  "s3://lakehouse/backups/pg/$STAMP/" /tmp/pg-drill/

# throwaway postgres in a scratch namespace
kubectl create ns restore-drill --dry-run=client -o yaml | kubectl apply -f -
kubectl -n restore-drill run pg-drill --image=postgres:17 \
  --env=POSTGRES_PASSWORD=drill --port=5432
kubectl -n restore-drill wait --for=condition=Ready pod/pg-drill --timeout=120s

# restore globals + one representative DB (langfuse), then spot-check
kubectl -n restore-drill exec -i pg-drill -- psql -U postgres < /tmp/pg-drill/globals.sql
kubectl -n restore-drill exec -i pg-drill -- pg_restore -U postgres -C -d postgres < /tmp/pg-drill/langfuse.dump
kubectl -n restore-drill exec pg-drill -- psql -U postgres -d langfuse -c "\dt" | head
# PASS = tables exist and a known table has a plausible row count.
```

## 2. Velero (PVC tier) — restore one PVC into the drill namespace

Velero restores whole namespaces; for a drill, restore the smallest
PVC-carrying workload (poet-poems) with a namespace remap.

```bash
LATEST=$(kubectl -n velero get backups --sort-by=.metadata.creationTimestamp \
         -o jsonpath='{.items[-1].metadata.name}')
kubectl apply -f - <<EOF
apiVersion: velero.io/v1
kind: Restore
metadata: { name: drill-$LATEST, namespace: velero }
spec:
  backupName: $LATEST
  namespaceMapping: { agentic-os: restore-drill }
  includedResources: [persistentvolumeclaims, persistentvolumes, pods, deployments]
  labelSelector: { matchLabels: { app.kubernetes.io/component: poet-agent } }
  restorePVs: true
EOF
# wait for phase Completed, then verify the data came back:
kubectl -n velero get restore drill-$LATEST -o jsonpath='{.status.phase}'
kubectl -n restore-drill get pvc          # poet-poems Bound
kubectl -n restore-drill exec deploy/poet-agent -- ls /data | head   # poems present
# PASS = PVC Bound + files visible. For the real thing (minio-data 20Gi),
# expect the kopia restore to take an hour-ish; drill it before cohort 1.
```

## 3. OpenSearch (mirror tier)

The OpenSearch indices live on a Velero-covered PVC, but the fastest restore
is the migration script's export/restore path against ANY running OpenSearch:

```bash
# the migration kept a full export under .opensearch-migration/<stamp>/ —
# re-import it (or a fresh export) with:
deploy/opensearch-pvc-migration.sh --restore-only .opensearch-migration/<stamp>
# PASS = per-index "restored ... verified" lines; os-ui Approvals/Audit populated.
```

## 4. Disaster case (worst realistic): node disk gone

Order of restore on a fresh cluster:
1. `make -C deploy stackit-up` (infra + chart from git) — platform up, stateless.
2. Velero restore of `agentic-os` PVCs (BSL is off-cluster, survives).
3. pg_restore of the newest dumps from the restored minio-data (or straight
   from the Velero copy of `backups/pg/`).
4. OpenMetadata: re-run its Search Indexing app; os-ui mirrors: re-mirror on
   write (or `--restore-only` from the latest export).

## Cleanup

```bash
kubectl delete ns restore-drill
kubectl -n velero delete restore drill-$LATEST
```

Log each drill (date, backup used, PASS/FAIL, time-to-restore) in the ops
notes; a failed drill is a sev-1 for the backup system.
