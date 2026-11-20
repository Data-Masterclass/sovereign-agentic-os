# Git bundles and automated restore drills (WP-56)

Everything here is **off by default**. It turns on in three steps: the owner creates the bucket
and its credential (§1), the image is built (§2), and the values are switched on (§3).

## What it does

| Piece | What | Where |
|---|---|---|
| Bundle after every commit | os-ui drops a marker after each successful commit or push; the `git-backup` sidecar runs git's own `git bundle create` (full on the first bundle of a UTC day, incremental against the previous bundle's tips after that), checks it with `git bundle verify`, and uploads it with its manifest (sha256, complete ref list, chain) and a `latest` pointer | `git-bundles/<repo>/<UTC-stamp>-<head12>.bundle`, `.json`, `latest` |
| Tamper evidence | Every hour, every repository's ref heads in one hash-chained record (each names the sha256 of the one before). Interim until the WP-08 audit anchor exists | `git-refs/<YYYY>/<MM>/<DD>/<stamp>.json`, `git-refs/latest` |
| Weekly drill | git: restore each repository's chain into a temp repo, `git fsck --full`, every ref equal to live, and EXACTLY the live inventory proven. Postgres: the newest pg-dump (at most `maxAgeHours` old) into a scratch server inside the drill pod; database set equal to live, no empty database, per-table row counts within `postgresCompare.maxDriftPct` of live; restored data deleted at once. OpenSearch: the newest snapshot (at most `maxAgeHours` old) into a temporary index prefix; index lists equal both ways, `_count` against live; copies deleted | CronJob `restore-drill` |
| Monthly Velero drill | newest backup of the Velero schedule, os-ui pod + claims only, mapped into `agentic-os-restore-drill`; a strategic-merge resource modifier keeps Velero's `restore-wait` init container (the node-agent fills the volume only while it runs) and replaces the app containers with a one-shot `git fsck --full`; then everything restored is deleted | CronJob `velero-drill` |
| Results | ConfigMap `restore-drill-status` (Monitoring reads it), `drills/<kind>/<stamp>.json` and `drills/<kind>/latest` in the bucket, one JSON log line `"event":"restore-drill-report"`, and a Failed Job | Monitoring → pipelines lens + alerts |

The commit never waits for the backup: the marker is written on a later turn of the event loop,
and a failure to write it is logged, never raised. A lost marker (pod restart) is caught by the
sidecar's full pass every `rescanSeconds`. This queue is the **interim** for the pg-boss outbox:
WP-07's pg-boss adapter is merged, but no OS process runs a queue or worker yet (WP-08). Alerts are the **interim** for WP-05: a failed bundle or drill is a red Monitoring
item and a critical alert in Monitoring, plus the log line and the Failed Job.

## 1. Owner: the bucket in STACKIT (the repository never creates cloud resources)

STACKIT Object Storage supports Object Lock (WORM) through the S3-compatible API, in COMPLIANCE
and GOVERNANCE modes, up to 365 days
([Object Lock basics](https://docs.stackit.cloud/products/storage/object-storage/basics/object-lock/),
[how-to](https://docs.stackit.cloud/products/storage/object-storage/how-tos/create-and-manage-object-lock/)).
Constraints from those pages:

- Object Lock can only be set **when the bucket is created**, and never removed.
- Versioning is switched on automatically with Object Lock, and cannot be suspended.
- **Both modes** (COMPLIANCE and GOVERNANCE) need the project-level **Compliance Lock** first:
  creating an Object Lock bucket or a retention policy without it returns 409. While Object Lock
  buckets exist, the Compliance Lock cannot be disabled and the project cannot be deleted.

Recommended: COMPLIANCE, 35 days default retention (a daily full bundle plus 30 days of history,
the same horizon as Velero's 30-day TTL).

> **Warning — COMPLIANCE is irreversible for the retention period.** A secret or personal data
> committed by mistake to any OS repository is bundled within seconds, and under COMPLIANCE
> **nobody** (not the owner, not STACKIT support) can delete that bundle for 35 days — a GDPR
> erasure request cannot be met from the bucket before then. Every overwrite of a `latest`
> pointer also leaves a new locked version. Rotate a leaked secret at once (deleting it from the
> repository does not remove it from locked bundles). If that risk is not acceptable, use
> GOVERNANCE: a holder of `s3:BypassGovernanceRetention` can then delete early.

```bash
REGION=eu01
PROJECT_ID=<your STACKIT project id>
TOKEN=<a STACKIT access token for that project>
BUCKET=dm-agentic-os-git-bundles
API=https://object-storage.api.$REGION.stackit.cloud/v1/project/$PROJECT_ID

# a) Project Compliance Lock (needed for COMPLIANCE mode; 409 = already on)
curl -sS -X POST "$API/compliance-lock" -H "Authorization: Bearer $TOKEN"

# b) The bucket, with Object Lock (versioning comes with it)
curl -sS -X POST "$API/bucket/$BUCKET?objectLockEnabled=true" -H "Authorization: Bearer $TOKEN"

# c) Default retention for every new object
curl -sS -X PUT "$API/bucket/$BUCKET/default-retention" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"mode": "COMPLIANCE", "days": 35}'
```

The same default retention through the standard S3 API (aws-cli), and the checks:

```bash
S3="aws --endpoint-url https://object.storage.eu01.onstackit.cloud s3api"
$S3 put-object-lock-configuration --bucket "$BUCKET" --object-lock-configuration \
  '{"ObjectLockEnabled":"Enabled","Rule":{"DefaultRetention":{"Mode":"COMPLIANCE","Days":35}}}'
$S3 get-bucket-versioning --bucket "$BUCKET"          # → "Status": "Enabled"
$S3 get-object-lock-configuration --bucket "$BUCKET"  # → Mode COMPLIANCE, Days 35
# after the first bundle: one object's retention
$S3 get-object-retention --bucket "$BUCKET" --key git-bundles/<repo>/latest
```

GOVERNANCE instead: the same calls with `"mode": "GOVERNANCE"`; a holder of
`s3:BypassGovernanceRetention` can then delete early with `--bypass-governance-retention`.

Old versions are never deleted by the OS (it cannot, under the lock). To keep the bucket from
growing forever, add a lifecycle rule that expires objects and non-current versions after the
retention period, if your project's supported operations list includes it
(`put-bucket-lifecycle-configuration`, `Expiration.Days` and `NoncurrentVersionExpiration` = 40).

**The credential.** STACKIT credentials are project-scoped. Create a dedicated credentials group
and credential for the bundles (rotation independent of Velero's), then the Secret:

```bash
kubectl -n agentic-os create secret generic git-backup-s3 \
  --from-literal=AWS_ACCESS_KEY_ID=<access key> --from-literal=AWS_SECRET_ACCESS_KEY=<secret key>
```

## 2. The image

Run `build-images.yml` for `backup-tools` (tag `backup-tools-v1.0.0`) and put the pushed digest in
`backup.gitBundles.image.digest`. The default digest is empty on purpose: with any of the three
features on, the chart **refuses to render** until the digest is set.

**Licence.** The image holds git (GPL-2.0-only) as an unmodified Alpine package. It is a separate
tool binary that the scripts run as its own process — never linked into OS code (the same as the
git-daemon and git-http images). The licence gate records it that way: `licenses/components.tsv`
row "git", and `GPL-2.0-only` is allowlisted for a separate tool binary only
(`licenses/allowed-licenses.txt`).

## 3. Switch on (a values overlay, applied with the deploy script)

```yaml
backup:
  gitBundles:
    enabled: true
    bucket: dm-agentic-os-git-bundles
    image: { digest: "sha256:<pushed digest>" }
  drill:
    enabled: true            # needs backup.pgDump.enabled for the Postgres part,
                             # and the WP-21 S3 snapshot repository for the OpenSearch part
    postgresCompare:
      # REQUIRED with the Postgres part (the render refuses an empty list): tables that must
      # hold rows in the restore, as "database:schema.table". Without them a small table that
      # restores empty can pass inside the row-drift allowance (minDriftRows).
      criticalTables: ["<db>:public.<table>", "..."]
  veleroDrill:
    enabled: true            # needs Velero (deploy/velero/) and its schedule's backups
    acceptRestoreCreateRisk: true   # see "Residual risk" below — the render refuses without it
```

Monitoring shows each enabled drill as RED, with a critical alert, when its report is
**missing** (the Job never reached its reporter), **overdue** (older than the schedule
allows) or **dated in the future**. Run the drill once by hand right after switching it on
(`kubectl -n agentic-os create job --from=cronjob/restore-drill restore-drill-first`), or it stays red until the
first scheduled run. A dump or snapshot stamped more than 1 h in the future also fails the drill.

### Residual risk of the Velero drill (accepted by the flag above)

The drill's ServiceAccount may `create` Velero `Restore` objects in the `velero` namespace.
Kubernetes RBAC cannot narrow that: Velero itself executes a Restore with its own cluster-wide
rights, so whoever holds that token could restore any backup into any namespace, or with
`existingResourcePolicy: update` overwrite live objects. The drill only ever creates a Restore
with `includedNamespaces: [agentic-os]`, `namespaceMapping: {agentic-os: agentic-os-restore-drill}`,
`includedResources: [pods, persistentvolumeclaims]`, the os-ui label selector and
`existingResourcePolicy: none`; the token lives only in the drill Job's pod (no other workload
uses the ServiceAccount), and the scratch namespace has a quota and a deny-all NetworkPolicy.
Velero offers no per-namespace restore permission (as of v1.15), so this is an accepted risk —
not a control. Leave the drill off if that is not acceptable.

The object-storage host joins the egress-proxy allowlist with the feature.

## Live evidence after the deploy (read-only)

```bash
kubectl -n agentic-os logs deploy/os-ui -c git-backup --tail=20       # "event":"git-bundle","status":"ok"
aws --endpoint-url https://object.storage.eu01.onstackit.cloud s3 ls s3://$BUCKET/git-bundles/ --recursive | tail
kubectl -n agentic-os create job --from=cronjob/restore-drill restore-drill-now   # owner-approved run
kubectl -n agentic-os logs job/restore-drill-now -c report                       # "event":"restore-drill-report","status":"pass"
kubectl -n agentic-os get configmap restore-drill-status -o jsonpath='{.data.weekly\.json}'
```

## The Velero drill by hand

```bash
velero restore create drill-manual --from-backup <newest backup of velero-daily-agentic-os> \
  --include-namespaces agentic-os --namespace-mappings agentic-os:agentic-os-restore-drill \
  --include-resources pods,persistentvolumeclaims --selector app.kubernetes.io/component=os-ui \
  --resource-modifier-configmap velero-drill-modifier
velero restore describe drill-manual --details
kubectl -n agentic-os-restore-drill logs -l app.kubernetes.io/component=os-ui -c velero-drill-check
# after the check
kubectl -n agentic-os-restore-drill delete pod,pvc --all
velero restore delete drill-manual --confirm
```

## Restoring a repository from its bundles

```bash
B=s3://$BUCKET/git-bundles/<repo>
aws s3 cp $B/latest latest.json
git init --bare restored.git
for key in $(jq -r '.chain[].key' latest.json); do
  aws s3 cp "s3://$BUCKET/$key" b.bundle
  git --git-dir=restored.git bundle verify b.bundle
  git --git-dir=restored.git fetch b.bundle '+refs/*:refs/restore/*'
done
git --git-dir=restored.git for-each-ref --format='delete %(refname)' refs/restore/ | git --git-dir=restored.git update-ref --stdin
jq -r '.refs | to_entries[] | "\(.key) \(.value)"' latest.json | while read -r ref sha; do git --git-dir=restored.git update-ref "$ref" "$sha"; done
git --git-dir=restored.git fsck --full
```

(The manifest's ref list is needed because git leaves an unchanged ref out of an incremental
bundle.)
