<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Rotating the LiteLLM master key, the salt key and the Langfuse credentials

The run-book for step 5 (LiteLLM master key and salt key) and step 7 i–ii (Langfuse project keys,
init-user password) of the rotation order in `docs/ops/litellm-upgrade.md` §3.2. The background
is in `docs/ops/litellm-salt-key.md`. Tooling: `scripts/ops/rotate-secrets.sh`.

Rules that hold throughout:

- New values are generated on the operator's machine (`openssl rand`) and live only in a private
  overlay outside git: `~/.sovereign-os-secrets/overlays/rotation-<date>.yaml`, mode 600. Next to
  it, the previous values (`….rollback.yaml`) and a state file with names, counts and sha256
  prefixes only (`….state.json`).
- Nothing prints a value. Keys travel in shell variables; curl reads them from stdin.
- Deploy the os-ui version that is **already live**, so the only change is the secrets.

## What changes, and what restarts

| Value | Secret → key | Readers | Restarts by itself on the deploy? |
|---|---|---|---|
| `litellmMasterKey` | `litellm-credentials` → `masterkey` | LiteLLM (`PROXY_MASTER_KEY`), os-ui (`LITELLM_MASTER_KEY`), the key-init Job | no — restart LiteLLM, os-ui |
| `litellmSaltKey.value` | `litellm-credentials` → `LITELLM_SALT_KEY` | LiteLLM (envFrom) | no — restart LiteLLM |
| `langfuseInit.publicKey` / `secretKey` | `langfuse-init` (`LANGFUSE_INIT_PROJECT_*`), `litellm-credentials` (`LANGFUSE_*`) | langfuse-web (headless init), LiteLLM, os-ui, os-ui-worker | os-ui and os-ui-worker **yes** (the public key is a plain env value in their pod template); langfuse-web and LiteLLM no |
| `langfuseInit.userPassword` | `langfuse-init` → `LANGFUSE_INIT_USER_PASSWORD` | langfuse-web, only when it creates the user | no, and a restart does not change an existing user (below) |

`scripts/ops/rotate-secrets.sh plan` shows this for the live release before anything is applied:
every object that changes, the Secret keys that change (by hash), and which workloads roll.

## The salt key in the chart

`litellmSaltKey` (`templates/base/litellm/_salt-key.tpl`):

- **local profile** (what renders `litellm-credentials` from values): `litellmSaltKey.value` is
  rendered into `litellm-credentials` as `LITELLM_SALT_KEY`. The gateway reads that Secret
  through `litellm.environmentSecrets`. Empty means not set; a laptop install renders as before.
- **other profiles**: the chart does not render `litellm-credentials`. `litellmSaltKey.existingSecret`
  is **required**: the operator- or ESO-managed Secret with key `LITELLM_SALT_KEY`, and it must be
  listed in `litellm.environmentSecrets`. The STACKIT profile names `litellm-credentials`.
- **Never changes once set.** On `helm install/upgrade` the chart reads the live
  `litellm-credentials` (`lookup`). If it already holds a `LITELLM_SALT_KEY`, a different value or
  an empty one fails the render with `LITELLM_SALT_KEY_CHANGE_REFUSED`, before anything is applied.
  `litellmSaltKey.allowChange: true` is for a full re-key only (`litellm-salt-key.md`, C), passed
  once on the command line and never left in an overlay: what an overlay sets stays in the
  release values, and the guard would stay off. `helm template`
  without a cluster cannot look up, so GitOps renderers must keep the value themselves.

## Langfuse: what the headless init does with changed values (3.194.1)

Read in `web/src/initialize.ts` at tag `v3.194.1`, which runs on every langfuse-web start:

- Organisation and project: `upsert` with `update: {}` — an existing one is never changed.
- API keys: looks the **public key** up. If no key with that public key exists, it **creates** the
  pair with exactly the given secret key (`createAndAddApiKeysToDb`, `predefinedKeys`). The old
  pair is not touched. So a new pair in `langfuseInit` is created headlessly on the next start,
  next to the old one, and the overlay alone is enough — the old pair is deleted in the UI.
  A changed secret key with an *unchanged* public key does nothing (the existing record wins).
- User: if a user with that e-mail exists, **its password is not changed**; only the org
  membership is re-asserted as `OWNER`. Langfuse's documentation says the same
  (langfuse.com/faq/all/self-hosting-default-login: "Initialization does not change the password of
  a user that already exists"; langfuse.com/self-hosting/administration/headless-initialization:
  resources are created "if they don't already exist").

Changing a password in the Langfuse UI needs transactional e-mail (`SMTP_CONNECTION_URL`) and a
verified e-mail address (`web/src/pages/auth/reset-password.tsx`, `credentialsRouter.resetPassword`).
This deployment has no SMTP, so the UI offers no password change. Langfuse's documented procedure
for that case (langfuse.com/self-hosting/security/authentication-and-sso#password-reset) edits the
`users` table; with sign-up disabled, the headless init takes the place of "sign up again".
The procedure is below and was rehearsed.

## Run-book

Before: a fresh `deploy/pre-upgrade-backup.sh`, a maintenance window (LiteLLM, Langfuse and os-ui
restart; everyone is signed out of the LiteLLM console once), no long agent run in flight.

### 1. Prepare (read-only on the cluster)

```bash
scripts/ops/rotate-secrets.sh prepare --context dmagenticos
```

It inventories, through a short-lived port-forward and with the current master key read from the
Secret into a shell variable:

- `GET /model/info`, the deployments with `model_info.db_model: true`;
- `GET /credentials`, stored credentials;
- `GET /v1/mcp/server`, MCP servers.

Then it chooses the path:

- **none stored** (all three 0): a new random salt key together with the new master key.
- **pin first** (anything stored, or a count it could not read): `LITELLM_SALT_KEY` = the current
  master key, so the stored values stay decryptable while the master key changes. In one deploy:
  the salt is what LiteLLM decrypts with once it is set. Follow up with `litellm-salt-key.md`
  procedure C (re-create the stored values under a new random salt and rotate the provider
  credentials they hold): until then the encryption key is the old master key.
- **salt already set** (also after a rollback): the salt key is kept unchanged, only the master
  key rotates.

It writes the overlay with `litellmMasterKey`, `litellmSaltKey.value` and a new
`langfuseInit.publicKey`/`secretKey`, the rollback overlay with the previous values, and prints the
next commands with the live version filled in.

### 2. Plan (read-only)

```bash
scripts/ops/rotate-secrets.sh plan --overlay ~/.sovereign-os-secrets/overlays/rotation-<date>.yaml \
  --chart <checkout>/charts/sovereign-agentic-os --context dmagenticos
```

It renders the chart with the live release values plus the overlay using `helm template --dry-run=server`, so the
salt guard runs as in the upgrade, and compares the result with `helm get manifest`. Expected:
`change Secret litellm-credentials: keys LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LITELLM_SALT_KEY, masterkey`,
`change Secret langfuse-init: keys LANGFUSE_INIT_PROJECT_PUBLIC_KEY, LANGFUSE_INIT_PROJECT_SECRET_KEY`,
the os-ui and os-ui-worker Deployments (the public key), and nothing else.
Anything else means the checkout is not the live chart: stop.

### 3. Deploy

From the checkout of the live release with the chart change applied (see "From a release tag"):

```bash
VALUES_OVERLAY=~/.sovereign-os-secrets/overlays/rotation-<date>.yaml ./scripts/deploy.sh --from-registry <live version>
```

deploy.sh prints which release values change. For this overlay that is `litellmMasterKey`,
`litellmSaltKey.value`, `langfuseInit.publicKey` and `langfuseInit.secretKey`, all `(hidden)`.
Then it takes the backup and runs the upgrade. os-ui and os-ui-worker roll during the deploy and
pick up the new master key. Until LiteLLM restarts, their admin reads answer 401. Model calls on
virtual keys are not affected. The `litellm-agent-key-init` Job runs with the new master key
against the old gateway: it retries (backoff) and succeeds once LiteLLM has restarted.

### 4. Restart the readers that do not roll by themselves

```bash
kubectl --context dmagenticos -n agentic-os rollout restart deploy/agentic-os-langfuse-web deploy/agentic-os-litellm
kubectl --context dmagenticos -n agentic-os rollout status  deploy/agentic-os-langfuse-web deploy/agentic-os-litellm --timeout=10m
kubectl --context dmagenticos -n agentic-os rollout restart deploy/os-ui deploy/os-ui-worker   # harmless if they already rolled
kubectl --context dmagenticos -n agentic-os rollout status  deploy/os-ui deploy/os-ui-worker --timeout=15m
```

langfuse-web first: its start creates the new key pair (headless init), so the clients that already
send with it are accepted. Traces sent between the os-ui roll and this restart are rejected.
The OS drops them without failing a run.

### 5. Post-checks

```bash
scripts/ops/rotate-secrets.sh verify --overlay ~/.sovereign-os-secrets/overlays/rotation-<date>.yaml --context dmagenticos --os-ui-exec
```

The script checks:

- the Secrets hold the new values (by hash);
- the old master key gets 401 and the new one 200;
- the database-stored models from step 1 are still listed and each answers a chat call;
- the shared virtual key lists models and completes a call;
- os-ui's own `LITELLM_MASTER_KEY` reads `/v1/models` and `/v1/mcp/tools`, the two reads behind
  Admin → LLM Gateway (`--os-ui-exec` runs `node` in the os-ui pod);
- the new Langfuse pair authenticates.

It ends `ROTATION_VERIFY_OK`. `VERIFY_MODEL=<alias>` picks the chat model for the virtual-key call;
`VERIFY_EMBED_MODEL=<alias>` uses `/v1/embeddings` instead. By hand, check that Admin → LLM Gateway opens, that a short agent run
completes, and that its trace arrives in Langfuse.

### 6. Langfuse UI (the owner)

1. Port-forward to `agentic-os-langfuse-web` and sign in. Go to project *Agent Core* → Settings →
   API keys. The new pair is listed with the note "Provisioned API Key", next to the old one.
2. **Delete the old pair.** It is the one whose public key the prepare step printed by hash and
   that is not the new one. Run `verify` again: the old pair must now get 401.

Alternatively, create the second pair in the UI (Create new API key). Then put it into a
hand-written overlay as `langfuseInit.publicKey`/`secretKey` instead of the generated one, and do
steps 3–5. The init finds that public key existing and leaves it alone.

### 7. Langfuse admin password (separately, after the keys)

The headless init does not change an existing user's password, and the UI cannot without SMTP.
os-ui signs in to the embedded Langfuse console with `LANGFUSE_SSO_PASSWORD`, read from
`langfuse-init` → `LANGFUSE_INIT_USER_PASSWORD` (from os-ui 0.9.20; an older os-ui used a built-in
default and would lose the automatic sign-in). So the Secret, the Langfuse user and os-ui must
agree: change the user, then the Secret, then restart os-ui.

```bash
scripts/ops/rotate-secrets.sh password            # writes ~/.sovereign-os-secrets/overlays/langfuse-password-<date>.yaml
```

1. Back up (`deploy/pre-upgrade-backup.sh`).
2. Move the existing user aside, as Langfuse's documented reset does (step 1 of their procedure).
   Run as the database owner in the `langfuse` database:
   `UPDATE users SET email = 'rotated-' || email WHERE email = '<init user e-mail>';`
3. Deploy with the password overlay
   (`VALUES_OVERLAY=<password overlay> ./scripts/deploy.sh --from-registry <live version>`), then
   `kubectl rollout restart deploy/agentic-os-langfuse-web`. The init now finds no user with that
   e-mail and creates it with the new password, as `OWNER` of the organisation. This replaces
   their steps 2–3, because sign-up is disabled. Then
   `kubectl rollout restart deploy/os-ui` so its `LANGFUSE_SSO_PASSWORD` is the new one.
4. Sign in with the new password. Under Organisation → Members the new user is Owner.
5. Delete the old user (their step 4): `DELETE FROM users WHERE email = 'rotated-<init user e-mail>';`
   Its memberships go with it (cascade).

Rollback before step 5: set the e-mails back (delete the new user first). After step 5: run the
procedure again with the previous password.

## From a release tag

The chart change is two commits, `feat(chart): LITELLM_SALT_KEY with a change guard; langfuseInit.userPassword`
and `fix(chart): allowChange is for a full re-key only`. Both touch the chart only and apply cleanly on
`os-ui-v0.9.19` and `os-ui-v0.9.20` (rehearsed). To deploy the live release with only the secrets
changing:

```bash
cd <checkout at os-ui-v<live version>>
git switch -c rotation/<live version> os-ui-v<live version>
git cherry-pick <feat(chart) commit> <fix(chart) commit>
helm dependency build charts/sovereign-agentic-os   # or copy charts/*.tgz from the tag checkout
scripts/ops/rotate-secrets.sh plan --overlay … --chart charts/sovereign-agentic-os   # step 2
VALUES_OVERLAY=… ./scripts/deploy.sh --from-registry <live version>                  # step 3
```

`rotate-secrets.sh` itself can run from any checkout of this change (it needs no chart). The image
stays the live one (`--from-registry <live version>`). The `plan` output of the rehearsal against
the 0.9.20 chart was exactly:

```
change  Deployment os-ui
change  Deployment os-ui-worker
change  Secret langfuse-init: keys LANGFUSE_INIT_PROJECT_PUBLIC_KEY, LANGFUSE_INIT_PROJECT_SECRET_KEY
change  Secret litellm-credentials: keys LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LITELLM_SALT_KEY, masterkey
rolls by itself (pod template changed): Deployment/os-ui, Deployment/os-ui-worker
```

The os-ui and os-ui-worker change is the env `LANGFUSE_PUBLIC_KEY` only. Delete the local branch
afterwards; the next release contains the change. Without the chart change the salt key cannot be
set from values.

## Rollback

```bash
VALUES_OVERLAY=~/.sovereign-os-secrets/overlays/rotation-<date>.rollback.yaml ./scripts/deploy.sh --from-registry <live version>
```

Then run step 4 again. The rollback overlay restores the previous master key and Langfuse pair and
**keeps the salt key**. The chart could not remove it in any case: a key dropped from a Secret's
`stringData` stays in the live `data` (measured in the rehearsal). Keeping it is safe on both paths:

- after "pin first" the salt equals the old master key;
- after "none stored" it is the key that anything stored since the rotation is encrypted with.

So the rollback needs no `allowChange`, and the guard stays on. The new Langfuse pair stays in
Langfuse until it is deleted in the UI. Rehearsed:

- the old master key was accepted again and the rotated one refused;
- the stored model was served;
- the virtual key worked;
- a rollback overlay that tried to remove the salt was refused by the guard.
