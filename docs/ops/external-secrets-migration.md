# Platform Secrets through External Secrets (WP-10)

Every platform credential becomes a Kubernetes Secret that the External Secrets Operator (ESO,
Apache-2.0) writes from **STACKIT Secrets Manager**. The Secret names, types and keys stay
exactly as they are, so no consumer changes: Deployments keep their `secretKeyRef`/`envFrom`,
and `scripts/ops/rotate-secrets.sh verify` reads the same Secrets.

Nothing changes until the owner runs the steps below. The chart's default is off.

- Pins and docs: `components/external-secrets/UPSTREAM.md`
- The Secrets ESO may own: `charts/sovereign-agentic-os/files/external-secrets/catalog.yaml`
- Chart glue: `charts/sovereign-agentic-os/templates/base/external-secrets/`
- Dry-run plan: `scripts/ops/eso-migration-plan.sh` (read-only; it has no apply mode)
- Proof against the real operator: `scripts/tests/external-secrets.kind.sh`

## How it works

1. One `ClusterSecretStore` named `stackit-secrets-manager`: ESO's `vault` provider, KV v2, server
   `https://prod.sm.eu01.stackit.cloud`, `path` = the instance ID (the KV mount), `userPass`
   auth with a **read-only** Secrets Manager user. Only the release namespace may use it.
2. One `ExternalSecret` per Secret in `externalSecrets.managed`. It reads
   `<instance>/<namespace>/<secret name>` (one KV secret, one property per key) and writes the
   Secret with the same name, type and keys. `creationPolicy: Orphan`: ESO writes and refreshes
   the Secret but does not own it, so deleting an ExternalSecret never deletes the Secret.
3. The handover. Helm renders most of these Secrets today. Release 1 (`externalSecrets.handover`)
   only adds `helm.sh/resource-policy: keep` to them. Release 2 (`externalSecrets.managed`) stops
   rendering them: Helm leaves them in place, and ESO overwrites them in place with the same
   values from Secrets Manager. The Secret never disappears, and no pod restarts because of it.
   Skipping release 1 would make Helm DELETE the Secret (Helm checks `keep` on the live object).
   Two guards stop that before anything changes: the chart's `lookup` fails the switch release
   for any Helm-owned live Secret without `keep`, and `scripts/deploy.sh` refuses any upgrade that
   would delete a live Secret without it (`scripts/lib/secret-deletion-guard.sh`). `scripts/rollback.sh`
   runs the same guard, current revision against target. The guard fails closed: a kubectl error
   refuses. Both scripts refuse a Helm client below 4.
4. Empty values. Every key goes through an ESO template that fails on an empty or whitespace-only value. An empty
   property in Secrets Manager leaves the ExternalSecret not Ready and the Secret unchanged; it never
   blanks a credential. Secrets with an empty value live (today `os-ui-graph`, `os-ui-smtp`: the
   features are not configured) are reported EMPTY by the plan and are not moved.

## 1. What the owner must do (once)

You need: the `stackit` CLI logged in to the project, `kubectl` with context `dmagenticos`,
`helm`, `jq`, `curl`.

1. **Create the instance**, restricted to the cluster's egress address and your own address for
   the copy step (STACKIT recommends always setting an ACL):

   ```sh
   stackit secrets-manager instance create --name sovereign-os-secrets \
     --acl <SKE egress CIDR> --acl <your public IP>/32
   ```

   Note the instance ID it prints. (The Terraform in `deploy/terraform/secretsmanager.tf` creates
   the same instance and users, but only together with the managed backends. Use the CLI, or
   `-target` only — never a plain apply.)
2. **Create two users.** Each password is shown once only.

   ```sh
   stackit secrets-manager user create --instance-id <id> --description eso-reader
   stackit secrets-manager user create --instance-id <id> --description migration-writer --write
   ```

   Keep the reader's username for `externalSecrets.store.username`, and its password for step 4.
   The writer is only for the copy (§2) and for rotations.
3. **Install ESO** (its own Helm release, namespace `external-secrets`):

   ```sh
   deploy/external-secrets/install.sh --context dmagenticos --dry-run
   deploy/external-secrets/install.sh --context dmagenticos
   ```

   It requests 30m CPU and 128 MiB memory, with 512 MiB of memory limits. The capacity gate already
   counts this (`capacity.yaml` `outsideChart`). The optional `bitwarden-sdk-server` subchart stays off.
4. **Create the bootstrap Secret** with the reader's password. It cannot come from the store it
   unlocks. Type the password at the prompt; it never lands on a command line:

   ```sh
   read -rs P && printf '%s' "$P" | kubectl --context dmagenticos -n external-secrets \
     create secret generic stackit-secrets-manager-eso --from-file=password=/dev/stdin; unset P
   ```

## 2. Copy the live Secrets (dry-run plan first)

```sh
scripts/ops/eso-migration-plan.sh --context dmagenticos --instance-id <id>
```

The plan lists every catalog Secret as MATCH (same name, type and keys live), ABSENT, or DIFFERS.
It refuses if one differs. For each MATCH it prints the one write that copies the Secret: the values
go from `kubectl get secret` through `jq` to `curl` on stdin, and nothing is printed. The writer's
token comes from a mode-600 header file:

```sh
umask 077; read -rs P
printf '{"password":"%s"}' "$P" | curl -sS --fail --data-binary @- \
  https://prod.sm.eu01.stackit.cloud/v1/auth/userpass/login/<writer username> \
  | jq -r '"X-Vault-Token: " + .auth.client_token' > ~/.sovereign-os-secrets/sm-header; unset P
export SM_HEADER=~/.sovereign-os-secrets/sm-header   # the token lasts 15 minutes
```

Then run the printed Step B lines, and delete the header file afterwards.

## 3. The two releases (announced deploys)

Put these values in the private overlay, not in the repo.

- **Release 1 — handover:** `externalSecrets.handover: [<the chart names from the plan>]`.
  The only change is the annotation. Check it with
  `scripts/ops/rotate-secrets.sh baseline`: only annotations change.
- **Release 2 — switch:**

  ```yaml
  externalSecrets:
    enabled: true
    store: {instanceId: <id>, username: <reader username>}
    managed: [<chart names>, <manual names>]
  ```

Before release 2, check that Secrets Manager is still an exact copy of the live Secrets. A value
rotated live after the copy would otherwise be replaced by the older copy. Log in as the **reader**
the same way as the writer above, into its own header file, then run:

```sh
SM_HEADER=<reader header file> scripts/ops/eso-migration-plan.sh --compare-backend --instance-id <id>
```

Every Secret must show SAME. The values are compared by sha256 inside the script and are never printed.

## 4. Verify (read-only)

```sh
kubectl --context dmagenticos get clustersecretstore stackit-secrets-manager      # Ready True
kubectl --context dmagenticos -n agentic-os get externalsecrets                     # all SecretSynced / True
scripts/ops/eso-migration-plan.sh --context dmagenticos --instance-id <id>         # all MATCH
scripts/ops/rotate-secrets.sh verify --overlay <the last rotation overlay>         # unchanged result
```

## Rollback

Remove the names from `externalSecrets.managed` (or set `enabled: false`) and deploy. The
ExternalSecrets are deleted. Their Secrets stay as they are (Orphan), and the chart renders them
again from the private overlay. The values in the overlay must still be the current ones.

## Rotation after the switch

Write the new value to Secrets Manager with the writer (never an empty value: ESO refuses it, and
the old value stays), and then
`kubectl annotate externalsecret <name> force-sync=$(date +%s) --overwrite`. Without that, ESO
picks it up within `refreshInterval` (1 h). Restart the readers as `docs/ops/secret-rotation.md`
describes; `rotate-secrets.sh verify` is unchanged. Not done yet: `rotate-secrets.sh prepare/plan`
still produce Helm overlays, and they do not cover ESO-managed Secrets.

## Not in this step

- Connection credentials themselves: they are durable Kubernetes Secrets (ciphertext) since PR #334,
  sealed under a data key that a key provider wraps. Their MASTER key `os-secrets-encryption-key` can
  come through ESO (`eso` provider, GitOps installs) — catalog entries `os-secrets-encryption-key` and
  `os-secrets-encryption-key-previous`, `scripts/ops/conn-key-secrets-manager.py`; see
  `docs/ops/connection-keys.md`. The default is the built-in key plus a recovery key.
- New Secrets that no consumer reads yet: `trino-service-users`, `dagster-runner-trino`
  (Trino T2, design 06), `trivy-server-token`. They are added to the catalog together with
  their consumers.
- `dagster-postgresql` (rendered by the Dagster subchart) and the TLS Secrets (cert-manager).
- `ci-runner-token`: its writer is outside this repo (the CI runner's Role may update it), and ESO
  would revert it at every refresh. It stays as it is.
