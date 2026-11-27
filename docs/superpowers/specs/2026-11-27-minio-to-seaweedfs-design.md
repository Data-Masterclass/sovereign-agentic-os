# MinIO → SeaweedFS ("MinIO B") — design and migration plan

- **Status:** Phase 1 (research + design). No implementation in this PR. Owner-approved direction ("MinIO B").
- **Date:** 2026-11-27
- **Scope:** replace the bundled MinIO (AGPL-3.0, forbidden by `licenses/policy.json`) with SeaweedFS
  (Apache-2.0) on dev and prod. Dev first. Prod only after the owner has tested dev and says go.
- **Out of scope:** STACKIT Object Storage ("external" mode, `values.stackit-managed.yaml`). It stays
  available and unchanged. This design covers the *bundled* store only.

## 0. Verdict

**Feasible: yes.** Every S3 feature the OS uses today is in SeaweedFS 4.52, including STS
`AssumeRole`, which Polaris uses for credential vending. SeaweedFS's own upstream integration test
covers Polaris credential vending (`test/s3tables/polaris/`). The licence picture is clean at the
application level.

Nothing blocks the work. Three things must be proven on dev before prod (§7). Each has a documented
upstream fallback:

1. **Polaris STS against SeaweedFS** (`AssumeRole` with a role from `-s3.iam.config`). Fallback if it
   fails: Polaris 1.2.0's documented `stsUnavailable: true` on the catalog's storage config.
2. **Iceberg writes (Trino CTAS / INSERT, pyiceberg, `expire_snapshots`) and multipart.** The chart
   comment says SeaweedFS "proved unreliable for Iceberg writes on kind". That was SeaweedFS 3.97
   (the `licenses/components.tsv` row). The claim has never been re-tested on 4.x. The kind e2e
   harness that runs the chart against SeaweedFS has failed before reaching any journey every night
   since 21 Nov (`e2e-kind`: missing helm repos). So there is no green evidence either way. Dev is
   where it gets proven.
3. **Volume sizing on a 20 Gi / 10 Gi PVC.** SeaweedFS pre-grows 7 writable volumes per collection
   (one collection per bucket) by default. That needs tuning (§3.4) or the first writes to a new
   bucket fail with "no free volumes".

**Effort:** about 5–7 engineer-days to a verified prod cutover (§10).
**Downtime:** prod write-freeze window of **about 30–45 min** (reads keep working for most of it).
Dev: about 15–20 min (§6).

## 1. Facts on the ground (2026-11-27)

| | prod (`dmagenticos`) | dev (`dmagosdev`) |
|---|---|---|
| Object store | bundled MinIO, `deployment/minio` (151 d) | bundled MinIO, `deployment/minio` (6 d) |
| Image | `ghcr.io/aborek/sovereign-os/minio@sha256:1887982b…` (Chainguard community build, ghcr mirror) | same |
| Data | PVC `minio-data` 20 Gi, `premium-perf1-stackit` | PVC `minio-data` 10 Gi |
| Resources | values: req 100m/512Mi, lim 1/1536Mi | `values.dev.yaml`: req 100m/256Mi, lim 1/512Mi (about 135 Mi in use) |

Object counts and bytes per bucket were **not** read for this design. The read-only `kubectl exec`
into MinIO was declined by the session's permission policy. The migration runbook (§6.1) starts by
measuring them with rclone (`rclone size`), which needs no exec.

Licence records today contradict each other (see `docs/compliance/image-licence-audit-2026-11-24.md`,
finding 2): `licenses/components.tsv` lists MinIO as `bundled=no` ("dev-only") and SeaweedFS 3.97 as
the bundled store. `THIRD-PARTY-LICENSES.md` says the same. But the chart deploys MinIO on both
clusters, and `components/minio/UPSTREAM.md` says "the OS ships it". The licence gate misses MinIO
because of the `bundled=no` row. This migration makes the records true.

The chart file `templates/base/object-storage/seaweedfs.yaml` already exists, but it deploys
**MinIO** (Deployment/Service `minio`). The bucket Job is named `seaweedfs-bucket-init` and uses
aws-cli. Only the names are SeaweedFS.

## 2. Inventory: every consumer of the bundled store

The endpoint comes from one helper, `soa.s3Endpoint` (`templates/base/_helpers.tpl`):
`http://minio:9000` when bundled, or `objectStorage.external.endpoint`. Credentials come from one
Secret, `objectStorage.secretName` = `object-storage-credentials` (`AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY`). Every consumer shares the same root key.

Buckets (`objectStorage.buckets`): `langfuse`, `lakehouse`, `sandbox`, `files`.

| Consumer | Where | Bucket / prefix | Client | S3 features used |
|---|---|---|---|---|
| **Polaris** (Iceberg REST catalog, 1.1.0) | `extensions/lakehouse/polaris.yaml`, `polaris-bootstrap.yaml` | `lakehouse/wh/` | AWS SDK v2 (Java) | Get/Put/Head/Delete, path-style, **STS `AssumeRole`** at `endpointInternal` with `roleArn arn:aws:iam::000000000000:role/polaris-lakehouse` + session policy (credential sub-scoping). Comments say this was verified live against MinIO. |
| **Trino 476** (Iceberg connector, native S3 FS) | `extensions/lakehouse/trino.yaml`, `_helpers.tpl:455` | `lakehouse/wh/` | Trino native S3 (AWS SDK v2) | Get (ranged), Put, **multipart upload** (large data files), List v2, **DeleteObjects** (batch; `expire_snapshots`, `remove_orphan_files`, DROP with purge), path-style, static keys (`vendedCredentials: false`) |
| **data-runner** (pyiceberg 0.8 + boto3) | `images/extensions/data-runner/app.py`, `extensions/lakehouse/data-runner.yaml` | `lakehouse/uploads/<uid>/`, `lakehouse/wh/` | boto3 GET; pyiceberg/pyarrow S3FS | GET, PUT, **multipart** (pyarrow), path-style |
| **northpeak-marts-init** (demo seed) | `extensions/lakehouse/northpeak-marts-init.yaml` | `lakehouse` | pyiceberg + aws-cli | `s3 ls`, `s3 mb`, Iceberg writes |
| **os-ui** (Data uploads, Files originals, OKF bundle freeze, domain delete) | `tabs/data/lib/object-store.ts`, `tabs/files/lib/object-store-server.ts`, `tabs/files/lib/physical-delete.ts`, `tabs/knowledge/lib/okf-freeze.ts` | `lakehouse/uploads/<uid>/`, `files/<owner\|domain>/…` | own SigV4 signer (Node crypto, no SDK) | single PUT (≤ 200 MB, buffered), GET, DELETE; path-style; **`x-amz-content-sha256: UNSIGNED-PAYLOAD`** |
| **Langfuse v3** (web + worker) | `values.yaml` `langfuse.s3` | `langfuse` | AWS SDK v3 (JS) | PutObject (event blobs), Get, List, Delete (retention), `@aws-sdk/lib-storage` **multipart** (batch exports), **presigned GET** (export download), `forcePathStyle: true`. Media upload (presigned PUT with `x-amz-checksum-sha256`) only if enabled. |
| **pg-dump CronJob** (`backup.pgDump`) | `extensions/backup/pg-dump-cronjob.yaml` | `lakehouse/backups/pg/<stamp>/` | aws-cli 2.31 | `s3 cp --recursive` (**multipart** above 8 MB, **CRC checksums by default**), `s3 ls`, `s3api list-objects-v2 --query LastModified` (retention), `s3 rm` |
| **restore-drill CronJob** | `extensions/backup/restore-drill-cronjob.yaml` | reads the pg dumps | aws-cli | GET, List |
| **bucket-init Job** | `base/object-storage/bucket-init.yaml` | all | aws-cli | `s3 ls`, `s3 mb` (CreateBucket) |
| **Velero** (fs-backup, kopia) | `deploy/velero/values.yaml` | the **`minio-data` PVC** (file level), not S3 | — | Crash-consistent file copy of the store's volume. Velero's *target* is STACKIT Object Storage, not MinIO. |
| **os-ui Admin → Platform** | `tabs/admin/lib/platform.ts:49` | — | — | Lists "MinIO (object storage)", console port 9001, shows the local login |
| **NetworkPolicy** `object-storage-allow-callers` | `base/network/platform-ingress-policies.yaml` | — | — | Admits control plane + trino, polaris, data-runner, marts-init, polaris-init, object-storage-init, pg-dump, Langfuse, OpenSearch on **:9000** |

**Not consumers** (checked):
- **Dagster / dbt** reach data only through Trino (no S3 client).
- **git-bundle backup** (`backup.gitBundles`) and **OpenSearch snapshots** (`opensearchSnapshots.s3`)
  write to STACKIT Object Storage, not MinIO. Their Object Lock / versioning needs land on STACKIT.
- The **app builder** templates and Tekton rego only *forbid* apps from importing the `minio` /
  `@aws-sdk` client libraries. That is a client-library rule and has nothing to do with the server.
  It stays as is.
- **MLflow** is listed in `deploy/terraform/objectstorage.tf` only. There is no MLflow in the chart.

**MinIO-specific tooling:** none at runtime. No `mc`, no MinIO admin API, no MinIO bucket policies,
no bucket notifications, no ILM. Bucket creation already uses aws-cli (Apache-2.0), as the
bucket-init comment says. The only MinIO-specific details are the health paths
(`/minio/health/ready|live`), the `MINIO_ROOT_*` env vars, the console port 9001, and the
names `minio` / `minio-data`.

**Features not used today** (no need to cover them): versioning, Object Lock, SSE / SSE-KMS, bucket
policies, lifecycle, notifications, IAM users per consumer, virtual-host addressing.

## 3. SeaweedFS against those needs

Source of truth: SeaweedFS tag `4.52` (commit `984eac6`, 2026-11-02, the version already pinned in
`tests/e2e/kind/versions.env`), read in full for the points below.

### 3.1 S3 compatibility matrix

| Need | SeaweedFS 4.52 | Evidence (upstream source) |
|---|---|---|
| Path-style addressing | yes (default; `-s3.domainName` only for vhost) | `weed/s3api/s3api_server.go` |
| SigV4 header auth, `UNSIGNED-PAYLOAD`, streaming chunked | yes | `auth_signature_v4.go`, `chunked_reader_v4.go`, `auth_signature_v4_unsigned_headers_test.go` |
| Presigned URLs (GET/PUT) | yes | `auth_presigned_*_test.go` |
| Multipart (initiate/upload/complete/abort/list parts) | yes | `filer_multipart.go` + tests |
| Flexible checksums (CRC32/CRC32C/CRC64NVME/SHA1/SHA256; aws-cli ≥ 2.23 defaults) | yes | `x-amz-checksum-*` handling, `test/s3/checksum` |
| ListObjectsV2, HeadObject, ranged GET, CopyObject | yes | `test/s3/basic`, `copying` |
| DeleteObjects (batch) | yes | `DeleteMultipleObjects` handler |
| Conditional writes (`If-None-Match`, `If-Match`) | yes | `s3api_object_handlers_conditional_write_test.go` |
| **STS `AssumeRole`** (SigV4-signed, named role + trust policy + session policy) | yes, when `-s3.iam.config` defines `sts` + `roles` | `weed/s3api/s3api_sts.go` `handleAssumeRole`; upstream Polaris test `test/s3tables/polaris/polaris_env_test.go` (role `arn:aws:iam::000000000000:role/PolarisVendedRole`) |
| Static identities with per-action / per-bucket rights | yes (`-s3.config` identities, actions like `Read:lakehouse`) | `auth_credentials.go`, SeaweedFS wiki "Amazon S3 API" |
| Versioning, Object Lock, SSE-S3/SSE-C/KMS, lifecycle, CORS, bucket policy | yes (not needed today) | `s3_objectlock/`, `s3_sse_c.go`, `lifecycle_xml/`, `policy_engine/` |
| Bucket notifications (S3 API) | no S3 `PutBucketNotification` (SeaweedFS has its own filer notification queue) | not used, no gap |
| Read-after-write consistency | yes for a single filer (strongly consistent metadata store) | single-filer deployment (§3.3) |

**No uncovered need.** One known semantic difference: `LastModified` on copied objects is the
copy time, not the original time. This affects the pg-dump retention after migration (§6.4).

### 3.2 Identities and STS config (`-s3.config` + `-s3.iam.config`)

One file (upstream allows the same file for both flags, as the Polaris test does) holds:

- `identities`: today **one** identity with the existing key pair from `object-storage-credentials`
  (parity, so no consumer changes credentials during cutover). Actions:
  `Admin, Read, Write, List, Tagging`.
- `sts`: `issuer`, `tokenDuration`, `maxSessionLength`, **`signingKey`** (secret).
- `roles`: `polaris-lakehouse` with `roleArn arn:aws:iam::000000000000:role/polaris-lakehouse`
  (the ARN `polaris-bootstrap.yaml` already writes). The trust policy should be restricted to the
  OS identity's ARN, not `"Principal": "*"` as in the upstream test. Attached policy: a
  `lakehouse`-only policy (`s3:*` on `arn:aws:s3:::lakehouse` and `arn:aws:s3:::lakehouse/*`).
- `policies`: that one policy.

The file holds secrets (secret key, STS signing key). It is rendered **only as a Secret** and never
inlined in values. Locally, the chart creates it from the documented local pair. On dev and prod it
comes from **External Secrets** (STACKIT Secrets Manager), templated with ESO's `target.template`.
That is the same mechanism and the same `soa.eso.owned` / `soa.eso.keep` helpers the chart uses
today. The signing key is a new Secrets Manager entry per environment (dev and prod separately, no
sharing).

**Hardening follow-up (separate WP, after cutover):** split the single root identity into
per-consumer identities with bucket-scoped actions: Polaris/Trino/data-runner on `lakehouse`,
Langfuse on `langfuse`, os-ui on `files` + `lakehouse/uploads`, pg-dump on `lakehouse/backups`.
SeaweedFS supports this natively. It is kept out of the cutover so the migration changes one thing
at a time.

### 3.3 Topology for our size

Single node in both clusters (prod one m3i.8-class node, dev m2i.4 / g2i.8). Therefore:

- **One pod, `weed server -s3`** (master + volume + filer + S3 gateway in one process). This is the
  upstream all-in-one mode and the one the kind harness already uses. `replicas: 1`,
  `strategy: Recreate`, one RWO PVC, replication `000`.
- **Not `weed mini`** (the image's default `CMD`). `mini` also starts WebDAV and the Admin UI, which
  is more surface than we need. It is upstream's "beginners/dev" mode.
- **Not the multi-StatefulSet layout** (separate master/volume/filer/S3). It only pays off with
  several nodes and costs about 4× the pods and memory.
- Filer metadata store: embedded **leveldb2 on the same PVC** (`/data/filerldb2`, the image's
  `/etc/seaweedfs/filer.toml`). Postgres as filer store is possible, but it would couple object
  metadata to pg-dump timing (§5) and add a cross-service dependency. Not worth it.
- **HA:** none, the same as MinIO today (single pod, RWO PVC). Real HA needs ≥ 3 nodes (3 masters
  with raft, ≥ 2 volume servers with replication `001`+). It is noted for the install-anywhere goal
  and is a later option. The upstream chart supports it.

### 3.4 Volume sizing (must be set explicitly)

SeaweedFS stores objects in fixed-size volumes. Each bucket is a collection. With default growth
(`master.toml` `copy_1 = 7`), the first write to a bucket asks for 7 writable volumes. Default
`volumeSizeLimitMB` is 30000 under `weed server`. On a 20 Gi PVC with 4 buckets this is wrong both
ways. The e2e harness hit it (`e8e71eee7`: "the first write to a bucket makes SeaweedFS grow
volumes"; it uses 64 MB).

Proposed starting values, measured and adjusted on dev:
- `-master.volumeSizeLimitMB=1024` (prod), `512` (dev)
- `-volume.max=0` (auto from free disk space) and `-master.volumePreallocate=false` (sparse, the default)
- volume growth `copy_1` lowered to 2 through a mounted `master.toml`. This is the documented
  scaffold (`weed scaffold -config=master`).
- **Prod PVC 20 Gi → 40 Gi** on the new claim. SeaweedFS needs free volumes per collection, and
  space from deletes only comes back after **vacuum** (master default: garbage threshold 0.3, every
  15 min). Iceberg `expire_snapshots` deletes are exactly that pattern. Dev 10 Gi → 20 Gi.

### 3.5 Resources

Our scale: one tenant, ≤ 20 Gi, low request rate. Expected: idle about 100–200 Mi RSS. Volume
needle index in memory is small at our object count; use `-volume.index=leveldb` to keep it on
disk. Start with the same budget MinIO has (prod req 100m/512Mi, lim 1/1536Mi; dev lim 512Mi), then
set from `kubectl top` on dev after a week. The capacity gate (`scripts/check-capacity.mjs`,
`capacity.dev-m2i4.yaml`) needs no change if limits stay equal.

### 3.6 Image and security posture

| | |
|---|---|
| Image | `chrislusf/seaweedfs:4.52@sha256:57877e32bb90073b37dc109b438ba66e84fd5ed9ced5f5c04f56444ef243ce59` (OCI index, amd64/arm64/…; label `org.opencontainers.image.licenses=Apache-2.0`, revision `984eac6`). Newer tags exist (4.55 `sha256:7ca46aea…`, 2026-11-23). Pin whichever is current and ≥ 2 weeks old at implementation time, and re-run §4 on it. |
| Edition | **Open-source `chrislusf/seaweedfs` only.** The upstream chart also mentions `chrislusf/seaweedfs-enterprise`, a commercial edition. It must never be used. The licence gate should fail on that repository name. |
| User | Image default user is root. `entrypoint.sh` chowns `/data` and drops to `seaweed` (uid 1000) via `su-exec` **only when started as root**. As non-root it simply execs `weed`. We run `runAsNonRoot: true`, `runAsUser: 1000`, `runAsGroup: 1000`, `fsGroup: 1000`, so the root branch never runs. This matches the `soa.podSecurityContext` / `soa.containerSecurityContext` helpers MinIO uses today. |
| PSS | restricted: no privileges, `allowPrivilegeEscalation: false`, drop ALL, `seccompProfile: RuntimeDefault`. FUSE (`weed mount`) is not used, so no `/dev/fuse` and no `SYS_ADMIN`. |
| Read-only root FS | yes. Writes go only to `/data` (PVC) and `/tmp` (emptyDir). Prove on dev with `readOnlyRootFilesystem: true`. |
| Network | Only the S3 port is a Service port. Internal ports (master 9333/19333, volume 8080/18080, filer 8888/18888) bind to loopback (`-ip=127.0.0.1 -ip.bind=127.0.0.1 -s3.ip.bind=0.0.0.0`), so the gRPC/HTTP admin surfaces are unreachable from the pod network. Prove on dev; if any component needs a pod-IP bind, the NetworkPolicy still admits only the S3 port. The filer UI is not exposed (`-filer.disableDirListing`). No metrics port until VictoriaMetrics scrapes it (then add a policy for the scraper only). |
| FIPS | The entrypoint sets `GODEBUG=fips140=on`. Keep it. |
| Probes | readiness/liveness: `GET /healthz` on the S3 port (SeaweedFS S3 health endpoint), replacing `/minio/health/*`. |

**Deployment form.** Two upstream-documented options:

- **(A, recommended) Own template in our chart** (`templates/base/object-storage/seaweedfs.yaml`,
  rewritten). It runs `weed server -s3 …` exactly as documented, like the kind harness, the MinIO
  template it replaces, and our other base services. It keeps our security helpers, labels,
  priority class, PVC naming and NetworkPolicy conventions in one place.
- **(B) Upstream chart `seaweedfs/seaweedfs` 4.52.0 (Apache-2.0) as a subchart with `allInOne.enabled: true`.**
  Also upstream-as-documented. But the all-in-one template has no `-s3.iam.config` flag (it would go
  through `extraArgs`). It brings its own Secret naming, a TLS cert template and an admin component
  we would have to switch off. It also adds a chart dependency to air-gapped installs.

Both are "use upstream as documented" with no reimplementation. (A) is smaller and matches how the
OS ships every other single-pod base service. Owner choice; (A) is assumed below.

### 3.7 Fallback candidates (only if dev proves a blocker)

| Candidate | Licence | Verdict |
|---|---|---|
| Polaris `stsUnavailable: true` (1.2.0) | Apache-2.0 | First fallback for item 1 in §0. Polaris stops vending credentials. Trino already uses static keys (`vendedCredentials: false`). Polaris's own FileIO then uses the catalog's static `s3.*` properties. Needs a Polaris 1.1.0 → 1.2.0 bump, which is its own small WP. |
| Garage | AGPL-3.0 | **Forbidden.** |
| MinIO forks (e.g. community builds) | AGPL-3.0 | **Forbidden.** |
| Ceph RGW (Rook) | LGPL-2.1/3.0 (Ceph), Apache-2.0 (Rook) | Policy-wise "exceptable weak" (separate program). Operationally far too heavy for one node (mon/mgr/osd/rgw). Not recommended. |
| Zenko CloudServer (Scality S3 server) | Apache-2.0 | Permissive and S3-compatible, but low activity, no STS, weaker multipart/consistency story. Last resort only. |
| STACKIT Object Storage (external mode) | managed service, no redistribution | Already supported by the chart. Valid for STACKIT installs, but it does not meet "install anywhere / air-gapped", so it cannot be the *bundled* answer. |

## 4. Licence check (done for this design)

Method: image exported with `crane export --platform linux/amd64` (nothing run). Go binary scanned
with `syft` (remote licence lookup). The Rust binaries' crate list was taken from build paths in the
binaries and looked up on crates.io.

| Layer | Result |
|---|---|
| SeaweedFS itself | **Apache-2.0** (repo `LICENSE`, image label) |
| `/usr/bin/weed` (Go, 246 modules) | MIT 78, Apache-2.0 64, BSD-3 38, BSD-2 10, ISC, multi-licensed permissive, and **MPL-2.0 × 17**: `hashicorp/raft`, `raft-boltdb/v2`, `vault/api`, `hcl`, `golang-lru` (v1; v2 is MPL/BSD), `go-retryablehttp`, `go-cleanhttp`, `go-multierror`, `errwrap`, `go-immutable-radix`, `go-rootcerts`, `go-secure-stdlib/{parseutil,strutil}`, `go-sockaddr`, `go-uuid`, and `go-sql-driver/mysql`. One `UNKNOWN`: `google/flatbuffers/go`, which is Apache-2.0 upstream (needs an alias/override entry). **No GPL, LGPL, AGPL, BUSL or SSPL.** |
| `/usr/bin/weed-volume`, `weed-worker`, `weed-vector` (Rust, 471 crates) | All permissive: MIT/Apache-2.0 (dual or single), Unicode-3.0, Unlicense/MIT, ISC, BSD-2/3, Zlib, BSL-1.0 (Boost), CC0/Apache-LLVM. All are in our `allow` list. We do not run these binaries, but they ship in the image. Caveat: the crate list comes from paths in the binaries, so a crate built without debug paths could be missed. The CI gate run (below) is the binding check. |
| OS layer (Alpine) | `busybox`, `apk-tools`, `alpine-baselayout`, `fuse`, `scanelf`, `ssl_client` (GPL-2.0-only), `libgcc`, `libidn2`, `libunistring` (GPL-2.0+ / LGPL), `ca-certificates-bundle` (MPL-2.0), `curl` (curl). These are the same Alpine OS-layer packages as in `git-http` and other images the audit already lists as needing a `separate-program` exception. |

**Policy outcome:**
- Application level: pass, with **MPL-2.0 entries in `licenses/exceptions.images.json`** (scope
  `seaweedfs`, condition `unmodified-not-linked`). They are linked into SeaweedFS, an unmodified
  separate program, never into our code. Plus one licence override for `flatbuffers/go`.
- OS layer: `separate-program` exceptions for busybox/fuse/apk-tools etc. These are the same
  pending entries the audit asks for on other Alpine images (one shared, reviewed entry set).
- If the owner prefers to avoid the Alpine OS layer altogether, an **option** (not part of the
  baseline) is our own `images/base/seaweedfs` image: the **upstream release binary**, unmodified
  and checksum-verified from the GitHub release, placed on a distroless static base. This follows the
  same pattern as `images/extensions/opensearch`. It drops all GPL OS packages, but we would own the
  image rebuild cadence.

**CI expectations** (`license-gate.yml`):
- Add `node scripts/license-gate-image.mjs --image chrislusf/seaweedfs:<pin> --scope seaweedfs --rootfs`.
  The Go binary inventory will need the gate's SBOM path (syft-style Go module read). Today
  `image-inventory.py` covers Python, embedded and npm. Extending it to Go buildinfo and Rust
  cargo-auditable data is part of the implementation WP.
- `licenses/components.tsv`: SeaweedFS row → `<pin> Apache-2.0 yes`. **Remove the MinIO row** (or set
  it to `no`, "removed <date>") once no chart path deploys it. rclone row (`bundled=no`, migration
  tool, §6) only if the migration Job image ships from the chart.
- `THIRD-PARTY-LICENSES.md` and `licenses/ATTRIBUTIONS.md`: SeaweedFS + the MPL-2.0 modules
  (attribution is required for every non-MIT/Apache licence per `policy.json`), plus BSD/ISC/Unicode
  entries as the gate's `--write-notices` produces them.
- Gate rule: deploying `chrislusf/seaweedfs-enterprise` must fail.

## 5. Backups with SeaweedFS (Velero)

Today Velero copies the `minio-data` PVC with kopia while MinIO runs. MinIO's immutable layout
tolerates that. SeaweedFS has two kinds of on-disk state:
- volume `.dat`/`.idx` files: append-only, tolerant of a crash-consistent copy;
- the filer's **leveldb2** directory: a live LSM database. A file-level copy taken mid-compaction can
  be inconsistent.

Design: a **Velero pre-backup hook** on the SeaweedFS pod (annotation
`pre.hook.backup.velero.io/command`) runs the upstream shell command
`weed shell -master=127.0.0.1:9333 -filer=127.0.0.1:8888` → `fs.meta.save -o /data/meta-backup/filer.meta /`.
This writes a consistent dump of all filer metadata to the PVC before kopia copies it. Restore: start
SeaweedFS on the restored volume. If leveldb is damaged, wipe `filerldb2` and run
`fs.meta.load /data/meta-backup/filer.meta`. Both commands are documented upstream (`weed/shell`).
`volume.fsck` verifies the restore against the volumes. The restore drill (`restore-drill-cronjob`)
gains one step: list buckets and object counts after a restore.

Unchanged: the pg-dump → `lakehouse/backups/pg/` → Velero chain (`docs/backups.md` tier 0/1). It
just runs on the new store.

## 6. Migration plan

**Tool: rclone** (MIT), the official image `rclone/rclone:1.76.0@sha256:7cbeec24a44f206067597c0368be4de90ae19a64d5113c7d1938bd737a81e466`
(2026-11-06; pin a then-current digest). rclone has both `provider = Minio` and
`provider = SeaweedFS` S3 profiles. It runs as a one-off **Kubernetes Job in `agentic-os`** under
restricted PSS (`runAsUser: 65534`, read-only root, config only through env
`RCLONE_CONFIG_SRC_*` / `RCLONE_CONFIG_DST_*` from the two Secrets, no inline keys). A temporary
NetworkPolicy admits that Job to both stores' S3 ports, and the Job and policy are deleted after the
run. It is not a chart hook; it is a runbook step (`scripts/ops/migrate-object-store.sh` renders and
applies it), because it must run exactly once per environment.

### 6.1 Phases (same for dev and prod; dev first)

**P0 — Prepare (no impact).**
1. Chart release N ships SeaweedFS **side by side**: new Deployment `seaweedfs`, PVC `seaweedfs-data`,
   Service `object-store` on port 9000, its own NetworkPolicy, buckets created by bucket-init
   pointed at it. All consumers still point at `http://minio:9000` (MinIO untouched).
2. Measure the source: `rclone size src:<bucket>` and `rclone lsf -R --format pst` per bucket. Record
   object count, bytes and the largest object. Check MinIO for versioned buckets
   (`aws s3api get-bucket-versioning`). Expected: none. If any are versioned, only current versions
   are migrated, by decision.
3. Fresh Velero backup + pg dump (`deploy/pre-upgrade-backup.sh`), as before every stateful change.

**P1 — Bulk pre-copy (live, no downtime).**
`rclone copy src:<b> dst:<b> --checksum --transfers 8 --s3-upload-cutoff 64M --s3-chunk-size 64M`
for each of `lakehouse`, `langfuse`, `files`, `sandbox`. Writes keep landing on MinIO. P2 picks up
the delta.

**P2 — Write freeze (the downtime window).**
1. Announce. Scale writers to 0 or suspend them: `os-ui-worker`, Dagster run launching (pause
   schedules/sensors via the daemon), `data-runner`, Langfuse `worker` (Langfuse `web` queues events
   in Valkey/ClickHouse ingestion; check on dev that nothing is lost, otherwise scale web too),
   CronJobs `pg-dump`, `restore-drill`, Trino maintenance, and `os-ui` itself (it writes Files and
   uploads; a maintenance page through the ingress is enough). Trino keeps answering reads.
2. Final delta: `rclone sync src:<b> dst:<b> --checksum` per bucket.
3. **Verify** (§6.2). It must pass before anything flips.

**P3 — Cutover.**
Chart release N+1: the Service **`minio` (port 9000) now selects the SeaweedFS pod**, and MinIO's
Deployment is scaled to 0 (PVC `minio-data` **retained**). Every consumer keeps `http://minio:9000`.
That matters because Iceberg table metadata and the Polaris catalog properties have
`s3.endpoint=http://minio:9000` **stamped in** (`table-default.s3.endpoint`, see
`polaris-bootstrap.yaml`). Changing the hostname would need a rewrite of every existing table's
properties. Keeping the Service name makes the cutover a selector change. Polaris credential vending
gets its role from the new IAM config, and `polaris-catalog-init` is unchanged.
Then unfreeze writers in reverse order and run the smoke set (§6.3).

**P4 — Settle and remove.**
After 14 days green, and only after the owner's go: delete the MinIO Deployment and image values,
then the `minio-data` PVC after one more Velero cycle. The Service name `minio` is renamed to the
generic `object-store` in a later release. That happens together with a one-off catalog/table
property rewrite (`polaris-catalog-init` already PUT-updates catalog properties idempotently;
existing tables need `ALTER TABLE … SET PROPERTIES` through Trino or a pyiceberg property update,
proven on dev first), or `minio` stays as a documented alias. Owner choice; no time pressure.

### 6.2 Verification (gate before cutover)

Per bucket:
- `rclone check src:<b> dst:<b> --download --one-way`: **byte-for-byte comparison**. ETags are not
  enough, because multipart ETags differ between stores. At ≤ 20 GiB this is minutes in-cluster.
- Object counts equal (`rclone size` both sides) and total bytes equal.
- A sample of 20 random keys per bucket: SHA-256 of a GET from both sides through the same S3 API.
- Iceberg: for every table registered in Polaris, `SELECT count(*)` through Trino before the freeze
  and after cutover. The numbers must match. Also `$snapshots` / `$files` metadata tables readable.
- Langfuse: open five traces with blobs in the UI after cutover.
- The verification output (counts, bytes, check summary) is attached to the WP PR as evidence. An
  **independent verifier** (a separate agent or person, not the implementer) re-runs `rclone check`
  and the Trino counts.

### 6.3 Smoke after cutover

Data-tab file upload → Bronze (os-ui PUT, data-runner GET, pyiceberg write). Trino CTAS into a
scratch schema plus `expire_snapshots` (multipart + DeleteObjects). Files upload, download and
delete (os-ui PUT/GET/DELETE). OKF bundle export. A Langfuse trace with a blob. A manual pg-dump Job
run, including its retention listing. A Polaris table create through the governed path (this
exercises STS `AssumeRole`).

### 6.4 Side effects to expect

- `LastModified` of every copied object becomes the copy time. Effect: the pg-dump retention prunes
  old dumps up to 14 days late, once. Acceptable; noted in the runbook. Iceberg does not use
  `LastModified`.
- Langfuse retention timestamps live in ClickHouse, not S3 metadata. No effect.

### 6.5 Downtime estimate

| | prod (≤ 20 GiB) | dev (≤ 10 GiB, synthetic) |
|---|---|---|
| P1 bulk copy (live) | 10–30 min | 5–15 min |
| P2 freeze → final delta | 2–5 min | 1–3 min |
| P2 verification (`check --download`, counts, Trino counts) | 10–20 min | 5–10 min |
| P3 cutover release + smoke | 10–15 min | 5–10 min |
| **Write downtime** | **about 30–45 min** | **about 15–20 min** |

Reads through Trino keep working during P2. The UI is in maintenance mode for the window. Do it in
an announced slot. On dev the slot is also the rehearsal that produces the real numbers for prod.

### 6.6 Rollback

- **Before P3:** nothing to roll back. Delete the SeaweedFS side.
- **After P3, within 14 days:** release N+2 points the `minio` Service selector back at MinIO and
  scales MinIO to 1 (its PVC was retained, with data as of the freeze). Writes made on SeaweedFS
  since cutover are copied back with `rclone copy dst: src: --checksum`. Same Job, reversed. Iceberg
  commits made after cutover point at data files that are copied back by that step, so the order is:
  freeze, then reverse copy, then flip the selector. Rehearsed once on dev.
- **Last resort:** Velero restore of the pre-cutover backup (P0 step 3).

## 7. Must-prove-on-dev checklist (gate to prod)

1. Polaris 1.1.0 → SeaweedFS STS `AssumeRole` returns temporary creds, and a CTAS through Trino
   commits. If not: Polaris 1.2.0 + `stsUnavailable: true` (§3.7), proven the same way.
2. Trino 476: CTAS of ≥ 1 GiB (multipart), INSERT, `optimize`, `expire_snapshots`,
   `remove_orphan_files`, DROP with purge on the purge catalog (`polaris.purge`).
3. pyiceberg 0.8 (data-runner) ingest of a 150 MB CSV.
4. aws-cli 2.31 `s3 cp` with default CRC checksums (pg-dump). If rejected, set
   `AWS_REQUEST_CHECKSUM_CALCULATION=when_required` in the Job. That is aws-cli's documented switch
   and the same choice `files/backup/lib.sh` already makes for STACKIT.
5. Langfuse event upload + batch export (multipart + presigned GET).
6. `readOnlyRootFilesystem: true`, loopback binds, NetworkPolicy enforced on Calico (dev is STACKIT
   Calico, unlike kind).
7. Volume growth on all four buckets with the §3.4 values, plus vacuum reclaiming space after
   `expire_snapshots`.
8. Velero backup with the pre-hook, restore into a scratch namespace, `fs.meta.load` path, and
   `volume.fsck` clean.
9. One week of `kubectl top` to set requests and limits.
10. The kind e2e harness (`e2e-kind`) fixed so that it actually runs the journeys. Its SeaweedFS
    manifest is aligned with the chart's new template (one source of truth) and journeys AT-b
    (data product) and AT-d (app) are green.

## 8. Files to change (implementation WP, for orientation)

Chart:
- `templates/base/object-storage/seaweedfs.yaml`: rewrite to SeaweedFS (Deployment `seaweedfs`,
  PVC `seaweedfs-data`, Service `object-store`, and the `minio` Service/selector handling for
  P0/P3/P4). Remove `MINIO_ROOT_*`, port 9001, `/minio/health/*`.
- New Secret template for `s3.json` / IAM config (local), and ESO `ExternalSecret` with template (dev/prod).
- `templates/base/object-storage/bucket-init.yaml`: endpoint from `soa.s3Endpoint` instead of the
  hard-coded `http://minio:9000`. Keep aws-cli.
- `templates/base/_helpers.tpl` `soa.s3Endpoint` (P4 rename only).
- `templates/base/network/platform-ingress-policies.yaml`: `object-storage-allow-callers` selects
  the new pod (same callers, port 9000). Update `scripts/check-platform-ingress-policy.mjs` and the
  kind test if names change.
- `values.yaml` `objectStorage.image` → SeaweedFS pin. New `objectStorage.seaweedfs.*` (volume size
  limit, growth, IAM Secret name). `persistence.size` 40Gi for prod overlays.
- `values.dev.yaml`, `values.dev.m2i4.yaml`: sizes and resources.
- Comments that say MinIO: `polaris.yaml`, `polaris-bootstrap.yaml`, `trino.yaml`, `data-runner.yaml`,
  `northpeak-marts-init.yaml`, `dbt-build.yaml`, `postgres/statefulset.yaml`, `_os-ui-env.tpl`,
  `_git-backup.tpl` / `restore-drill-cronjob.yaml` (`NO_PROXY` keeps `minio` while the alias lives).
- `deploy/velero/values.yaml` comment, plus the pre-backup hook annotation on the pod.
- `deploy/terraform/objectstorage.tf` comment ("bundled MinIO" → SeaweedFS).

os-ui (strings and metadata only, no logic change):
- `tabs/admin/lib/platform.ts` (component entry: name, no console, no login string),
  `core/kernel/licenses.ts` (MinIO → SeaweedFS Apache-2.0), `core/manifest.ts` and the
  `tabs/*/manifest.ts` service id `minio` → `object-store`, `core/kernel/config.ts` default
  `S3_ENDPOINT` comment, `os-ui/messages/*` (34 files with "MinIO" strings, all 7 languages).

Licences and records: `licenses/components.tsv`, `THIRD-PARTY-LICENSES.md`, `licenses/ATTRIBUTIONS.md`,
`licenses/exceptions.images.json`, `components/minio/UPSTREAM.md` (delete),
`components/seaweedfs/UPSTREAM.md` (now "the bundled store", chart path, pin),
`components/README.md`, `.github/workflows/license-gate.yml`, `docs/compliance/` (a follow-up note
closing audit finding 2).

Docs: `docs/components/minio.md` → `docs/components/seaweedfs.md` (access via port-forward to S3
only, no console; `weed shell` for operators), `docs/backups.md` (store name, pre-hook, restore
steps), `docs/under-the-hood.md`, `docs/components/{polaris,trino,langfuse,os-ui,query-tool}.md`,
`docs/ops/dev-environment.md`, `docs/ops/WP-secret-rotation.md` and
`scripts/lib/rotate-datastores.sh` / `rotation-datastores.py` (rotation must rewrite the IAM config
Secret and restart SeaweedFS instead of MinIO's root user), `deploy/README.md`, `README.md`,
`CONTRIBUTING.md`, `.env.example`, `CHANGELOG.md`, `docs/i18n/glossary.md`, `docs/mcp/tool-reference.md`.

Tests: `tests/lakehouse/compose.yaml` and `tests/langfuse/compose.yaml` (MinIO containers →
SeaweedFS), `tests/domain-delete/*`, `tests/e2e/kind/*` (use the chart's bundled SeaweedFS instead of
a separate manifest), `scripts/tests/secret-rotation/*`, `scripts/tests/home-chat/run.sh`,
`scripts/tests/litellm-langfuse/run.sh`.

## 9. Side finding (not part of this WP)

`os-ui/tabs/files/lib/object-store-server.ts` keeps an in-process memory copy of every Files upload.
If the durable PUT fails, it serves from memory with a `console.warn`. The upload looks successful
but disappears on the next pod restart. That is a silent fallback, contrary to the "no silent
fallbacks" rule. Worth its own small fix (fail the upload honestly). It matters during the
migration window because a frozen or unavailable store would otherwise produce "successful" uploads
that vanish.

## 10. Effort

| Work | Days |
|---|---|
| Chart: SeaweedFS template, IAM/ESO Secret, NetworkPolicy, values, side-by-side + selector cutover mechanics | 1.5 |
| Polaris STS proof on dev (and fallback if needed) | 0.5–1 |
| Migration Job + runbook script + verification script | 1 |
| Velero pre-hook, restore drill step, backup docs | 0.5 |
| Licence gate (Go/Rust inventory), exceptions, records; os-ui strings ×7 languages; docs | 1 |
| Test harnesses (compose, kind e2e fix), secret-rotation update | 0.5–1 |
| Dev rehearsal (full P0–P3 + rollback drill) + independent verifier | 1 |
| **Total** | **about 6–7 days**, plus the prod window after the owner's go |

## 11. Decisions for the owner

1. Deployment form: own template (A, recommended) or upstream chart all-in-one (B).
2. Upstream Alpine image with `separate-program` OS-layer exceptions (baseline), or our own
   distroless image carrying the unmodified upstream binary (option).
3. P4: rename the `minio` Service with a table-property rewrite, or keep `minio` as a permanent
   documented alias.
4. Per-consumer identities as a follow-up WP right after cutover (recommended) or later.
