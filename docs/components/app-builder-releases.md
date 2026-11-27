# App Builder releases, Dev/Prod, previews, logs, rollback (workstream C2)

How a green build becomes a running app in Dev, a preview slot and Prod. Spec:
`docs/superpowers/specs/2026-11-26-app-builder-design.md` §6.3–6.6, §9, §14. Code: `os-ui/tabs/software/lib/releases/`,
`review.ts` (go-live section), `native-deploy.ts`, `runner.ts`. Everything is behind `softwareRunner.environments.enabled`
(default off: no route, tool, reconcile or object).

## The flow

1. A push (or Run checks) starts the `app-checks` run. For a v2 app with a configured build platform, `tekton-checks.ts`
   names the image repository `apps/<domainKey>/<slug>` and the domain's push Secret (created on first build).
2. When the run's record FINISHES (`checks-sync.ts`), the story lights are refreshed (workstream B) and `auto-dev.ts`
   decides: green by `recordVerdict`, image scan passed, a digest from the PipelineRun's `digest` result, the newest
   commit, not released yet ⇒ a **Dev release**, then the same release into a **preview slot**.
3. Every rollout is `rollout.ts`: committed `k8s/` at the sha validated with the app's domain → digest present in the
   app's OWN repository (Zot, read-only pull identity) → `deploying` record → **pre-deploy hooks** (D: `app-env`, then
   `migrations`; a refusal fails the release before anything is applied) → closed overlay → dry run → apply →
   `running`, audited.
4. **Prod** = `request_deploy` (UI: Code and runs → Go live) on the current Dev release, under the Platform go-live rule
   table: reviewer `none` ⇒ live at once; otherwise a review card + Governance approval, decided by `decide_deploy` by an
   eligible reviewer who is not the requester. Gates the rules never skip: green run, both scans, digest = the run's,
   and (Domain/Company) no unreviewed pushed change (B's `unreviewedBlocksGoLive`).
5. **Rollback** (`rollback_app`) = a new release of the previous digest, no hooks (migrations stay applied: the card lists
   them with the forward-only warning). Prod rollback needs the go-live right of the app's scope.

## Names and the overlay

| Object | Name |
|---|---|
| Deployment, Service, Ingress | `appResourceName(domain, slug)` (slots: `…-p1`, `…-p2`) |
| Hosts | Prod `<label>.<domain>.<appsDomain>`, Dev `<label>.<domain>.dev.<appsDomain>`, slots `<label>--p1|p2.<domain>.dev.…` (same rule as the app sign-in callback hosts; `--` is a form no slug can take, so a slot host never equals any app's env host; a new v2 app never takes a slug ending in `-p1`/`-p2`) |
| TLS secret | `<host>-tls` (the apps admission policy's rule) |
| Image | `<pull host>/apps/<domainKey>/<slug>@<digest>` |
| Release file | `os/releases/apps/<slug>.yml` in the domain repository (`os/releases/` is reserved for the dbt whole-tree generator) |

The overlay changes exactly `metadata.namespace`, the container image and the Ingress host + TLS secret (a test diffs
every other field). The Deployment additionally carries the release record (`soa.dev/release`, `soa.dev/release-sha`,
`soa.dev/release-tags`).

## Without a builder

No gated builder digest or no build isolation ⇒ os-ui's app registry is empty: the gates still run, no image is built,
and every release path answers the `no_builder` reason naming what to configure (`docs/components/app-builder-build.md`).
Releases are testable without builds: push a prebuilt image to `apps/<domainKey>/<slug>` in Zot and record a green run
with that digest (the unit tests inject the registry, git and the cluster).

## Previews and the reconcile

Two fixed slots per app. A new Dev release takes the slot already serving its sha, else an empty one, else the slot with
the older release. Slots share the Dev database and env Secret. The release reconcile (`reconcile.ts`, every 10 min,
started only with the switch on) scales slots idle for 8 h to zero (`start_preview` wakes them) and marks legacy image
apps "needs rebuild".

## Needs rebuild (spec 14)

Legacy image apps whose committed image names a registry other than the configured one are MARKED
`deploy.state = 'needs-rebuild'` (the reconcile holds no Kubernetes client). `run_app_migration` (admin, explicit, audited,
agent runs refused) scales the legacy `agentic-apps` Deployment to 0, `undo: true` back to 1. After an app's first Prod
release its legacy objects are deleted. Both act only on a Deployment that is provably this app's: the legacy
namespace is shared by every domain and the name is `app-<slug>`, so the runner's record (`sovereign-os.io/live-tag` =
`live/app/<app id>`) must name this app, or, without a record, no other image app of any domain may share the slug;
anything else is refused (`legacyOwnership`).

## Logs

`pods/log` of the env namespace, pods selected by the exact `app.kubernetes.io/name=<deployment>` label (re-checked per
pod); editors of the app only. Redacted before they leave os-ui: OS tokens, JWTs, Bearer/Basic credentials, private
keys, postgres URLs, `password=` pairs and the values of the app's own secret env NAMES (os-ui never reads the env
Secret, so names are the anchor). os-ui never logs log content.

## Database TLS (verify-full)

CNPG's CA Secret `<cluster>-ca` holds the CA key, so app pods never mount it. The chart's `apps-pg-ca-publisher` CronJob
(per env namespace, own ServiceAccount: get on that one Secret, patch on one ConfigMap; egress to the API server only,
granted by the pod label `soa.dev/role: apps-pg-ca-publisher` — a reserved label no app pod may carry)
copies `ca.crt` into the ConfigMap `<cluster>-ca-cert`. v2 app pods mount it read-only and run with
`PGSSLMODE=verify-full`, `NODE_EXTRA_CA_CERTS` (pg), `PGSSLROOTCERT` and `PGREQUIREAUTH=scram-sha-256` (libpq). Before
the first copy a pod cannot connect (fail closed). The migrate/isolation Jobs keep `no-verify` (D's Job policy admits no
volume) — **follow-up**: verify-full for the Jobs needs the CA ConfigMap admitted by D's Job policy.

## Registry retention: release tags (open, C1)

`release-<env>-<id>` tags are reserved for a platform identity; os-ui holds no registry write credential. The rollout
records the tags each env must keep in the Deployment annotation `soa.dev/release-tags` (JSON tag → digest). **C1's
`zot-users` keeper must read that annotation and apply the tags with its keeper identity** (not done in C2: C1's Go tool
and Role). Until then the keeper's `keep-*` tags protect every running digest; only a rollback target no pod runs any
more relies on the release tag.

## Job image binding (D's admission policy, tightened by C2)

A migrate/isolation Job is admitted only when its image is `<registry or pull host>/apps/<domainKey of
soa.dev/domain>/<soa.dev/slug>@sha256:…`, the annotations name a DNS-label domain, and an uncut Job name starts with
`app-<domain>-<slug>-`. The domainKey's 8-hex hash is checked by shape (CEL cannot hash); os-ui derives repository,
annotations and name from the same app record.

## Agent runs (owner decision)

`rollback_app` into Prod is refused for an agent run (the tool checks the run id of the request surface); into Dev it is
held for a person under every preset (`hold.ts ALWAYS_CONFIRMED_TOOLS`). `run_app_migration` is agent-forbidden.
People keep both under the UI's rights.

## Known limits

- The receive gate's `k8s/` validator gets the file, not the repository's domain (core `RepoKind.validate`), so it accepts
  a file valid for ONE of the apps with that slug; the release re-validates against exactly one app and D's pod policy
  binds Secrets to the workload name. Passing the domain needs a change in `core/infra/git-receive.ts`.
- The Job policy checks the domainKey's 8-hex hash by shape only (CEL has no sha256); os-ui derives image, annotations
  and name from one app record.
- A v2 go-live decision is serialised per card in the process (os-ui runs one replica with the App Builder on).

