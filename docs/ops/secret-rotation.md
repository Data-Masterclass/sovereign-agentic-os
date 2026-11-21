<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Rotating the platform's default secrets

The run-book for replacing every credential the chart renders from a literal in `values.yaml` on
the `local` profile:

- the LiteLLM master key, and a salt key with it;
- the LiteLLM console password;
- the agent-runtime token;
- the Langfuse project key pair;
- the Langfuse core secrets (`salt`, `nextauthSecret`, `encryptionKey`);
- separately, the Langfuse admin password.

It implements steps 2, 5 and 7 of the rotation order in `docs/ops/litellm-upgrade.md` §3.2. The
LiteLLM background is in `docs/ops/litellm-salt-key.md`. Tooling: `scripts/ops/rotate-secrets.sh`
(header: every subcommand).

Rules that hold throughout:

- New values are generated on the operator's machine (`openssl rand`). They are written only to
  private files outside git, mode 600: `~/.sovereign-os-secrets/overlays/`. Add that directory to
  any git work tree's ignore file it sits in (for example `~/.gitignore` when `~` is one).
- Nothing prints a value. Values travel in shell variables and reach curl, psql, node and python
  on stdin.
- Every overlay is **bound** to the cluster it was prepared on (the kube-system namespace UID),
  to the namespace and release, and to the live master key it expects before it is applied.
  `plan` and `verify` refuse any other cluster, release or step. So run `prepare` against
  production immediately before the window and use that run's files.
- Deploy the os-ui version that is **already live**, with only the rotation chart support added
  ("Deploying only the secret changes" below).
- deploy.sh leaves its derived `release-values.yaml` (it holds the new values) in its temporary
  directory, which it prints at the end. Delete it after the window. Keep the rollback overlays.

## What changes, and what restarts

| Value (overlay) | Secret → key | Readers | Restarts by itself on the deploy? |
|---|---|---|---|
| `litellmMasterKey` | `litellm-credentials` → `masterkey` | LiteLLM (`PROXY_MASTER_KEY`), os-ui (`LITELLM_MASTER_KEY`), the key-init Job | no — except when `litellm.envVars` changes too (both re-key steps), which rolls LiteLLM |
| `litellmSaltKey.value` | `litellm-credentials` → `LITELLM_SALT_KEY` | LiteLLM | no |
| `litellm.envVars.LITELLM_MIGRATE_FROM_MASTER_KEY` (re-key: the old key in step 1, `""` in step 2) | — (pod env) | LiteLLM at boot | **yes**, LiteLLM |
| `litellmUI.password` | `litellm-credentials` → `UI_PASSWORD` | LiteLLM console login, os-ui's console sign-in | no |
| `agentRuntime.token` | `agent-runtime-token` → `token` | os-ui, the Dagster code server (`agentic-os-dagster-user-deployments-sovereign`, code server and repo-sync sidecar), the schedule and catalog CronJobs (read at each run) | no |
| `langfuseInit.publicKey` / `secretKey` | `langfuse-init`, `litellm-credentials` (`LANGFUSE_*`) | langfuse-web (headless init), LiteLLM, os-ui, os-ui-worker | os-ui and os-ui-worker **yes** (the public key is plain env); the others no |
| `langfuseInit.salt` / `nextauthSecret` / `encryptionKey` | `langfuse-core-secrets` | langfuse-web, langfuse-worker | no |
| `langfuseInit.userPassword` | `langfuse-init` → `LANGFUSE_INIT_USER_PASSWORD` | os-ui's Langfuse console sign-in (`LANGFUSE_SSO_PASSWORD`); langfuse-web only when it creates the user | no |

`plan` shows this for the live release before anything is applied: every object that changes, the
Secret keys that change (by hash), and which workloads roll by themselves. `verify` checks that every
reader has a pod started after the deploy.

## The production secret guard and the deploy preflight

In production, os-ui and the run worker refuse to boot when a secret they read is missing or equals
a development default published in this repository (`os-ui/core/kernel/secret-guard.ts`; it knows
the defaults only as SHA-256 digests). `scripts/deploy.sh` checks the same thing **before** an
upgrade (`scripts/lib/check-secrets-not-defaults.py`): it is read-only, compares by hash only, and
stops with `SECRET_PREFLIGHT_FAILED` and the list of variable names. The rotation on this page is
what makes that check pass.

| Variable | Read by | Where it comes from | Notes |
|---|---|---|---|
| `LITELLM_MASTER_KEY` / `PROXY_MASTER_KEY` | os-ui; the gateway; the `litellm-agent-key-init` Job | Secret `litellm-credentials` → `masterkey` | on `global.profile: local` the chart renders it from `litellmMasterKey` |
| `AGENT_RUNTIME_TOKEN` | os-ui, os-ui-worker; the Dagster code server and its repo-sync sidecar; agent schedule CronJobs | Secret `agent-runtime-token` → `token` | rendered from `agentRuntime.token` on `local` |
| `OS_SESSION_SECRET`, `OS_MCP_TOKEN_SECRET` | os-ui | Secret `os-ui-session` | generated per install by the chart; normally nothing to do |
| `AGENT_KEY_ENCRYPTION_KEY` | os-ui, os-ui-worker | Secret `os-ui-agent-key-encryption` (External Secrets catalog entry of the same name) | generated per install and kept across upgrades; the agent systems' model keys are stored encrypted under it. Do NOT rotate it like the others: a new value makes every stored key unreadable until os-ui re-issues them at its next start (or a Rebuild) |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` | os-ui, os-ui-worker; the gateway (`litellm-credentials`, envFrom) | `langfuseInit.publicKey` (plain env) and Secret `langfuse-init` → `LANGFUSE_INIT_PROJECT_SECRET_KEY`; the same pair in `litellm-credentials` | one value pair, three places, all rendered from `langfuseInit` on `local` |
| `LANGFUSE_SSO_PASSWORD` (the Langfuse admin login) | os-ui (the embedded console sign-in) | Secret `langfuse-init` → `LANGFUSE_INIT_USER_PASSWORD` | rendered from `langfuseInit.userPassword` on `local`; Langfuse applies the init password only when it first creates the user, so the password is changed in Langfuse itself (step 2) |
| `TERMINAL_BROKER_SECRET` | os-ui, only when `TERMINAL_ENABLED=true` | os-ui env | nothing reads it while the terminal is off; set it in the same change that enables the terminal |

Release values the preflight requires (on `global.profile: local` an unset one renders the
chart's laptop value, and the preflight names it):

- `litellmMasterKey` (os-ui `LITELLM_MASTER_KEY`, gateway `PROXY_MASTER_KEY`);
- `agentRuntime.token` (os-ui and worker `AGENT_RUNTIME_TOKEN`; the Dagster code server and the
  schedule CronJobs);
- `langfuseInit.publicKey` / `langfuseInit.secretKey` (os-ui, worker, and the gateway's copy);
- `langfuseInit.userPassword` (os-ui `LANGFUSE_SSO_PASSWORD`, the Langfuse admin login).

`OS_SESSION_SECRET` / `OS_MCP_TOKEN_SECRET` are generated per install and need nothing.

## LiteLLM: what is encrypted, and the complete re-key

LiteLLM 1.109.1 encrypts **21 columns**. They are listed in
`litellm/proxy/db/master_key_migration.py` `_SECRET_COLUMNS`:

- stored models and credentials;
- `LiteLLM_Config` (console env vars and settings);
- guardrails, SSO and cache config, config overrides;
- MCP servers (4 columns), MCP OAuth clients, MCP user credentials and env vars, SSO identity assertions;
- search tools;
- the `callback_vars` in team, key, user and deleted-team/key metadata.

The key is `get_salt_key()`: `LITELLM_SALT_KEY`, or the master key when that is unset.

`prepare` counts them with **LiteLLM's own scan**. `scripts/ops/litellm-stored-secrets.py` runs in the
LiteLLM container through a read-only `kubectl exec`. It uses `_secret_columns_in`, `_rows_of`,
`replace_ciphertexts` and `decrypt_if_encrypted_with`, SELECT only, and prints counts only.
`verify` runs the same scan after each step. It requires every column to hold as many values
decryptable with the key now in use as before, and none decryptable with the retired master key.
The HTTP endpoints `/model/info`, `/credentials` and `/v1/mcp/server` see 3 of the 21 columns.
`/credentials/migrate-encryption/check` cannot tell a lost value from plaintext. So neither is used.

**The complete re-key (the default path while no salt key is set).** LiteLLM 1.109.1 re-encrypts
every stored value at boot when `LITELLM_MIGRATE_FROM_MASTER_KEY` names the previous master key.
This happens only while `LITELLM_SALT_KEY` is absent from its environment, and the target is the
master key (`migrate_if_requested`, `_migrate`). Hence two deploys:

1. **Step 1:**
   - Set: `litellmMasterKey` = a new random S and `litellm.envVars.LITELLM_MIGRATE_FROM_MASTER_KEY` = the old key. No salt key yet.
   - LiteLLM rolls by itself and logs `Done re-encrypting N stored value(s)`.
   - `verify`: every value is now decryptable with S, and none with the old key.
2. **Step 2:**
   - Set: `litellmSaltKey.value` = S, `litellmMasterKey` = a new random M, and the variable to `""`.
     A `null` cannot delete it: deploy.sh layers the overlay over the release values, which set it
     in step 1, and the subchart renders every `envVars` key. With the value empty, LiteLLM does
     nothing at boot (`_migrate`: a salt key is set; and nothing is encrypted under an empty key).
     The old key is no longer in the gateway's env (rehearsed, and asserted by the chart test).
   - The in-place secrets change in the same deploy.
   - S is the encryption key from then on, and no longer accepted as a master key (401).

This leaves no published value as the encryption key and needs no re-creation of stored values. The
alternatives stay available with `--path`:

- `pin-first` keeps the old master key as the salt. It needs procedure C of `litellm-salt-key.md`
  afterwards, and that procedure must then cover all 21 columns.
- `none-stored` is refused unless LiteLLM's scan finds no stored value at all.

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

## Langfuse core secrets (3.194.1)

Read in the Langfuse source at tag `v3.194.1`:

- **`nextauthSecret`** signs the sessions. While it is a public value, anyone who can reach
  langfuse-web can forge an admin session, so rotating the password alone does not close Langfuse
  admin access. Rotating it signs everyone out once.
- **`salt`** is used only for the API keys' fast lookup hash (`web/src/features/public-api/server/apiAuth.ts`,
  `packages/shared/src/server/auth/apiKeys.ts`). After a change the fast lookup misses. Langfuse then
  verifies the secret against the key's bcrypt hash (`hashedSecretKey`, which does not depend on the
  salt), looked up by public key, and writes the new fast hash. **No key pair stops working,
  including the old one**, so the owner must still delete the old pair in the UI. The salt rotates
  in the same deploy as the new pair. The headless init creates that pair under the new salt.
  Rehearsed: the old and new pairs both answered 200 after the salt change, and the old one
  answered 401 after its deletion.
- **`encryptionKey`** encrypts, at rest, the secrets of the LLM connections (`llm_api_keys`), the
  integrations (`blob_storage_integrations`, `posthog_integrations`, `mixpanel_integrations`,
  `slack_integrations`), automations (`actions`), SSO (`sso_configs`) and callouts
  (`web_callout_endpoints`). These are all the tables written through `encrypt()` in
  `web/src` and `packages/shared`. `prepare` counts their rows (psql in pg-0, read-only) and
  rotates the key **only when all are 0**. Otherwise it keeps the current key and says so. To
  rotate it then:
  1. note each such entry (Langfuse UI: Settings → LLM Connections, Integrations, Automations);
  2. delete it;
  3. run `prepare` again (the key is now rotated) and the run-book;
  4. re-enter the entries.

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

## Rehearsal

`scripts/tests/secret-rotation/rehearse.sh` runs the whole rotation on the real components:

- the chart's gateway image (LiteLLM 1.109.1 at its pinned digest), config and env, rendered from the
  chart, on Postgres 17;
- Langfuse 3.194.1 web and worker on their documented stack.

It uses the same in-container artifacts as `rotate-secrets.sh`: LiteLLM's scan, the encrypted-table
count, langfuse-web's bcryptjs and the one-row UPDATE. Only the Kubernetes steps are replaced by
their effect on the containers' environment. On top, the chart test renders the re-key overlays
through Helm's values merge. It ends `SECRET_ROTATION_REHEARSAL_OK` (44 checks), including the
negative twins:

- a random salt key alone loses every stored value;
- an LLM connection makes the encryption count 1.

## Run-book (production)

Before:

- a fresh `deploy/pre-upgrade-backup.sh`;
- a maintenance window (LiteLLM, Langfuse and os-ui restart; everyone is signed out of both consoles);
- no long agent run in flight;
- the checkout described in "Deploying only the secret changes".

1. **Prepare** (read-only). It runs two exec steps, named before they run. Each one reads inside a
   `READ ONLY` transaction, so Postgres refuses any write:
   ```bash
   scripts/ops/rotate-secrets.sh prepare --context dmagenticos
   ```
   It prints:
   - the encrypted columns that hold values, and the path (`re-key` while no salt key is set);
   - whether the Langfuse `encryptionKey` rotates;
   - the files it wrote, and the exact commands that follow, with the live version filled in.
2. **Re-key step 1** (re-key path only):
   ```bash
   scripts/ops/rotate-secrets.sh plan --overlay <…>.step1.yaml --chart charts/sovereign-agentic-os --context dmagenticos
   VALUES_OVERLAY=<…>.step1.yaml ./scripts/deploy.sh --from-registry <live version>
   scripts/ops/rotate-secrets.sh verify --overlay <…>.step1.yaml --context dmagenticos
   ```
   `plan` must show only:
   - `Secret litellm-credentials: keys masterkey`;
   - `Deployment agentic-os-litellm`, which rolls by itself.

   `verify` must end `ROTATION_VERIFY_OK (step1)`, with every column at its full count under the
   new key and 0 values under the old one. Between this step and the next, os-ui's admin reads answer
   401 (it still holds the old key). Model calls on virtual keys are not affected.
3. **Final step:**
   ```bash
   scripts/ops/rotate-secrets.sh plan --overlay <…>.yaml --chart charts/sovereign-agentic-os --context dmagenticos
   VALUES_OVERLAY=<…>.yaml ./scripts/deploy.sh --from-registry <live version>
   kubectl --context dmagenticos -n agentic-os rollout restart deploy/agentic-os-langfuse-web deploy/agentic-os-langfuse-worker deploy/agentic-os-litellm
   kubectl --context dmagenticos -n agentic-os rollout status  deploy/agentic-os-langfuse-web deploy/agentic-os-langfuse-worker deploy/agentic-os-litellm --timeout=10m
   kubectl --context dmagenticos -n agentic-os rollout restart deploy/os-ui deploy/os-ui-worker deploy/agentic-os-dagster-user-deployments-sovereign
   kubectl --context dmagenticos -n agentic-os rollout status  deploy/os-ui deploy/os-ui-worker deploy/agentic-os-dagster-user-deployments-sovereign --timeout=15m
   scripts/ops/rotate-secrets.sh verify --overlay <…>.yaml --context dmagenticos --os-ui-exec
   ```
   `plan` must show only:
   - the Secrets `litellm-credentials`, `langfuse-init`, `langfuse-core-secrets` and `agent-runtime-token`;
   - the Deployments `agentic-os-litellm` (the variable emptied), os-ui and os-ui-worker.

   `verify` must end `ROTATION_VERIFY_OK (final)`. Besides the step-1 checks, it covers:
   - the old master key and S are refused;
   - the stored models are served;
   - the virtual key works;
   - the console password: new 200, old 401;
   - the new Langfuse pair is accepted;
   - every reader restarted after the deploy;
   - os-ui's own credential is accepted.

   By hand:
   - Admin → LLM Gateway opens;
   - a short agent run completes and its trace arrives in Langfuse;
   - `kubectl logs deploy/agentic-os-litellm | grep -iE 'decrypt|salt|Invalid model'` shows nothing new.
4. **Owner, Langfuse UI:** project *Agent Core* → Settings → API keys. Delete the **old** pair (the
   new one is listed as "Provisioned API Key"). Run `verify` again: the old pair must now get 401.
5. **Langfuse admin password**: see below.
6. Delete deploy.sh's `release-values.yaml`. Keep the overlays (mode 600).

### Langfuse admin password (the one database write; the owner approves it)

The headless init never changes an existing user's password, and the UI cannot change it without
SMTP. The minimal and reversible path is to write a new bcrypt hash into the one `users` row. This
is the same write that Langfuse's own `updateUserPassword` does, at cost 12. The user's id and every
membership stay the same.

```bash
scripts/ops/rotate-secrets.sh password --context dmagenticos                      # new password overlay + rollback + state
scripts/ops/rotate-secrets.sh password-db --overlay <pw>.yaml --context dmagenticos   # DRY RUN: shows the steps
scripts/ops/rotate-secrets.sh password-db --overlay <pw>.yaml --context dmagenticos --apply   # owner's approval
VALUES_OVERLAY=<pw>.yaml ./scripts/deploy.sh --from-registry <live version>
kubectl --context dmagenticos -n agentic-os rollout restart deploy/os-ui && kubectl --context dmagenticos -n agentic-os rollout status deploy/os-ui
scripts/ops/rotate-secrets.sh verify-password --overlay <pw>.yaml --context dmagenticos
```

`--apply` does the following:

1. It makes the hash with langfuse-web's own `bcryptjs` at cost 12. The password reaches `node` on stdin.
2. It saves the current hash next to the overlay (`<pw>.old-hash`, mode 600).
3. It runs one `UPDATE users SET password = … WHERE email = <init e-mail> AND password = <saved hash>`
   through `kubectl exec pg-0 -- psql`. The command must answer `UPDATE 1`.

The deploy then puts the same password into `langfuse-init`, so os-ui's console sign-in
(`LANGFUSE_SSO_PASSWORD`) matches. `verify-password` signs in through NextAuth: the new password
must work and the old one must be refused.

Rollback: `password-db --overlay <pw>.yaml --rollback --apply` restores the saved hash. Then
deploy `<pw>.rollback.yaml` and restart os-ui.

## Deploying only the secret changes

Deploy the **live release tag** with the overlays, and nothing else. Do not bundle the rotation with
a release, and do not deploy a newer main.

From `os-ui-v0.9.23` the tag already contains every piece of chart support the rotation needs:

- `litellmSaltKey` with its change guard (`templates/base/litellm/_salt-key.tpl`);
- `langfuseInit.userPassword`;
- the Langfuse core secrets as `langfuseInit.{salt,nextauthSecret,encryptionKey}`
  (`templates/base/langfuse/core-secrets.yaml`);
- `litellmUI.password`;
- `agentRuntime.token`.

So no cherry-pick and no copied template is needed:

```bash
git fetch origin --tags
git switch --detach os-ui-v0.9.23        # the live release
helm dependency build charts/sovereign-agentic-os
```

Run `rotate-secrets.sh` from a checkout of main (it needs no chart), with `plan --chart` pointing
at this checkout's `charts/sovereign-agentic-os`. Run deploy.sh from this checkout with
`--from-registry 0.9.23`. Two checks before the first overlay:

- `scripts/ops/rotate-secrets.sh baseline --chart charts/sovereign-agentic-os --context dmagenticos`
  (the tag with no overlay, against the live release) must change **0 objects**;
- `plan` of each overlay must change only Secrets and env. Measured against the live 0.9.23 release
  with throwaway overlays:
  - step 1: `Secret litellm-credentials` (masterkey), plus `env` of `Deployment agentic-os-litellm`
    and of `Job agentic-os-litellm-migrations` (plus its `checksum/config` annotation);
  - final: the Secrets `litellm-credentials`, `langfuse-init`, `langfuse-core-secrets` and
    `agent-runtime-token`, plus `env` of agentic-os-litellm, os-ui, os-ui-worker and the
    migrations Job;
  - 0 objects added or removed.

  The migrations Job's pod template is immutable, so `plan` refuses while a Job from the previous
  deploy still exists. It deletes itself 120 s after it finishes: wait that long between step 1
  and step 2.

This main's `core-secrets.yaml` also refuses an `encryptionKey` that is not 64 hex characters. The
tag does not, and the rotation does not need it: `prepare` generates the key with `openssl rand -hex 32`.

`plan` **refuses a chart whose checkout does not contain the live release tag**
(`os-ui-v<live version>`). Deploying such a chart would roll production back. Delete the branch
afterwards: the next release contains the change, and the overlay values stay in the release values.

## Rollback

| From | Overlay | Then |
|---|---|---|
| re-key step 1 | `<…>.rollback-step1.yaml`: the old master key with `LITELLM_MIGRATE_FROM_MASTER_KEY` = S, so LiteLLM re-encrypts S → old | LiteLLM rolls by itself. Afterwards deploy an overlay setting the variable to `""` |
| the final step | `<…>.rollback.yaml`: the previous master key, console password, agent token, Langfuse pair and core secrets; **the salt key stays** | the restarts of step 3 |
| the password | `password-db --rollback --apply`, then `<pw>.rollback.yaml` | restart os-ui |

The salt key stays because Helm cannot remove a key from a live Secret's `data` when it disappears
from `stringData` (measured), and because every stored value is encrypted with it.
