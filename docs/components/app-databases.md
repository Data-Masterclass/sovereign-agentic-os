# App Builder app databases, env and secrets (workstream D)

One Postgres database and one role per App Builder app and env, an app's own env variables and secrets, and
migrations from git run before every rollout. Spec: `docs/superpowers/specs/2026-11-26-app-builder-design.md` §7, §13.
Everything here is behind `softwareRunner.environments.enabled` (default off: nothing renders, os-ui env unchanged)
AND `osUI.software.databases.mode: cnpg` (default `""`).

## What runs where

| Piece | Where | Owner |
|---|---|---|
| CloudNativePG operator 1.30.2 (Apache-2.0) | `cnpg-system`, installed by `scripts/cnpg/install.sh` (pins: `scripts/cnpg/versions.env`) | platform operator |
| Cluster `apps-pg` (1 instance), its NetworkPolicies | `apps-dev`, `apps-prod` — `templates/base/os-ui/software-app-databases.yaml` | chart |
| os-ui Role + two admission policies narrowing it | `templates/base/os-ui/software-app-databases-rbac.yaml` | chart |
| Per app: basic-auth Secret `app-…-db`, managed role, `Database`, isolation Job, env Secret `app-…-env` + its name list (ConfigMap `app-…-env`), migrate Job | env namespace | os-ui (`core/adapters/cnpg/client.ts`, `tabs/software/lib/appdb/*`) |

Names come from domain AND slug (`appDbIdent`, `appResourceName`), identical in both env namespaces, so the app's
manifest (`deploy-env-block.ts`: PG* env, `envFrom` the env Secret, `APP_DOMAIN`) is the same in Dev and Prod.

## Isolation (both layers tested on kind: `tabs/software/lib/appdb/appdb.kind.test.ts`)

1. `pg_hba`: `hostssl sameuser all all scram-sha-256` then `host all all all reject`. A role reaches only the database
   of its own name; the cluster's `app`/`postgres` databases are closed too.
2. Before the app's first migration the isolation Job runs **as the app's own role** (database owner), from the app's
   release image with the fixed `node /app/migrate/isolate.mjs`: `REVOKE CONNECT, TEMPORARY ON DATABASE … FROM PUBLIC`.
   With pg_hba relaxed, role A still gets `permission denied for database B`. os-ui never starts a Job from another
   image (never the CNPG operand image).
3. Network: apps-pg admits 5432 only from app pods (`app.kubernetes.io/part-of: sovereign-os-apps`) and
   `soa.dev/role: app-migrate` Jobs of its own namespace, 8000 only from the operator; a pod in `apps-dev` cannot reach
   `apps-prod`'s cluster.
4. No superuser credential exists (`enableSuperuserAccess: false`) and os-ui never connects to Postgres: the operator
   applies role and database inside the instance.
5. os-ui's rights there are narrowed by admission policies on its own identities (`software-app-databases-rbac.yaml`,
   proven on kind): on the Cluster only `spec.managed.roles` may change (every other `.spec` property — compared from
   `charts/.../files/cnpg/cluster-spec-fields.txt`, which `scripts/cnpg/check-crd-fields.mjs` keeps complete at install
   — plus `managed.services`, labels, annotations and finalizers stay as they were), and every role is a plain LOGIN
   role `app_…_<h8>` without privilege flags or `inRoles`, `ensure: present`, its password Secret bound to it by the same
   hash; ownerReferences and the rest of the Cluster's metadata cannot change either; a Database is `app_…_<h8>` owned
   by itself, `retain`, `present`, with no other property; os-ui **cannot read any Secret** there (no get/list/watch):
   it only creates and patches `app-…-<h8>-(db|env)`, a `-db` credential is never changed, CNPG's `apps-pg-*` are
   never touched, and the owner annotations of an existing Secret/ConfigMap are immutable (how a foreign one is
   refused without reading it); a Job os-ui starts runs only an app release image from the app registry by digest
   (`jobImagePrefix`), one container, the fixed migrate or isolate command, read-only root filesystem; every pod os-ui writes
   (Deployments — C1's Role — ReplicaSets, StatefulSets, DaemonSets, Jobs, CronJobs, Pods incl. the deploy's dry run)
   names only its OWN `-db`/`-env` Secret (derived from the workload name), mounts no service-account token, uses the
   default ServiceAccount, carries no certificate or private key as a literal env value and no `cnpg.io/*` label
   (`soa.dev/role` only `app-migrate` on a Job). The deploy
   gate (`native-deploy.ts`) refuses the same labels in a committed manifest and accepts exactly a v2 app's own
   `appResourceName(…, 'db' | 'env')` Secrets.
6. A Secret of the expected name that belongs to another app (annotations `soa.dev/domain`/`soa.dev/slug`) is never
   adopted.

TLS: app pods (C2) verify the cluster: `PGSSLMODE=verify-full` against the CA CERTIFICATE in the ConfigMap
`<cluster>-ca-cert` (copied by the chart's `apps-pg-ca-publisher` CronJob from `<cluster>-ca`, which holds the key and is
never mounted), plus `PGREQUIREAUTH=scram-sha-256` for libpq clients (docs/components/app-builder-releases.md). The
migrate and isolation Jobs keep `no-verify` (`pg`) / `require` (psql): their admission policy allows no volume.

## Env and secrets

Write-only: values live only in the env Secret's data, which os-ui writes and never reads; the list (name, kind, who,
when) is the ConfigMap of the same name (`data.meta`). Names `^[A-Z][A-Z0-9_]{0,63}$`; `PG*`, `OS_*`, `APP_*`, `KUBERNETES_*`, `LD_*`, runtime, TLS-switch and proxy names refused
(`lib/appdb/env-names.ts`, shared by server and UI). Platform keys `APP_ENV`, `OS_PUBLIC_URL` are written by the
`app-env` pre-deploy hook. A change rolls the app's Deployments in that env (and both preview slots in Dev) through a
pod-template annotation. Prod changes need the go-live right of the app's scope (Platform rule table). Audited by
name (action `deploy`, `detail.kind` `app.env.set|unset`, `app.database.ensure`), never the value.

## Migrations

`db/migrations/NNNN_*.sql` (node-pg-migrate SQL format). The v2 Dockerfile's `migrate` stage installs node-pg-migrate
9.0.0 + pg 8.23.1 from the platform-owned `migrate/` lockfile into `/app/migrate`. The `migrations` pre-deploy hook
first runs the isolation Job once per database, then a Job from the RELEASE image (digest only) with the fixed command, as the app role, waits for its verdict, and
records `App.database[env].migrations`. A failure returns the log tail and stops the rollout; the previous release
keeps running. Forward-only: rollback never runs `down` (expand/contract rule in the template's
`docs/rules/own-database.md`). The first Prod release creates Prod's database.

## Licence (owner decision pending)

- Operator: Apache-2.0; Go modules all permissive (syft SBOM of the pinned digest, 2026-11-27). Its distroless base
  adds data packages only (base-files, netbase: GPL-2; ca-certificates: MPL-2.0/GPL-2+; tzdata: public domain).
- **Operand image: every CloudNativePG PostgreSQL image is a Debian userland around PostgreSQL** (candidate
  `ghcr.io/cloudnative-pg/postgresql:18.6-minimal-trixie@sha256:ec2ed340…`: bash, coreutils, grep, sed, tar, gzip,
  dpkg, apt, gnupg — GPL-2/3; glibc, libgcrypt, … — LGPL; perl — GPL/Artistic; PostgreSQL itself — PostgreSQL licence;
  no AGPL or source-available component found). Under the policy these need a reviewed `separate-program` exception
  (like `git`), or a different image. So `osUI.software.databases.imageName` has **no default** and the chart refuses
  to render the clusters without it. Options for the owner: (a) an exception entry for the CNPG operand image
  (unmodified, separate programs; PostgreSQL never linked into our code); (b) build a minimal PostgreSQL image (musl,
  no shell, `--without-readline`) and verify CNPG runs it; (c) `databases.mode: external` (built later).
- App images gain `pg` (MIT) and `/app/migrate` (node-pg-migrate MIT; glob & co. BlueOak-1.0.0, attributed in
  `migrate/NOTICE`). `licenses/fragments/d.json` inventories all of it for H's fold.

## Operate

```bash
bash scripts/cnpg/install.sh --kubeconfig <file> [--priority-class <preemptionPolicy: Never class>]   # 0 replicas first, capacity guard 85 % incl. the planned instances
bash scripts/cnpg/install.sh --kubeconfig <file> --uninstall   # refuses while any CNPG Cluster exists
```

Backups of app databases are not built (Prod panel: "no backup configured"). `databases.mode: external` is designed
(an existing server plus an admin credential the adapter uses to create database and role), not built.
