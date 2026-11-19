<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# LiteLLM: the salt key and master-key rotation

A maintenance procedure for the operator. **Nothing in the chart sets `LITELLM_SALT_KEY` today,
and this document does not change that** — adding it is a deliberate, separate step, because
done carelessly it silently removes every model an admin registered in the console.

## What the salt key is

LiteLLM encrypts some values before it stores them in its Postgres database: the credentials
(`api_key`, `api_base`, …) of models added through the console or `/model/new`
(`LiteLLM_ProxyModelTable`), stored credentials (`LiteLLM_CredentialsTable`), settings saved from
the console (`LiteLLM_Config`) and MCP server credentials. The key it uses is
`LITELLM_SALT_KEY` — and when that variable is not set, **the master key**
(`litellm/proxy/common_utils/encrypt_decrypt_utils.py`, `_get_salt_key`).

This deployment sets `STORE_MODEL_IN_DB=true` and no salt key. So today:

* the master key is also the database encryption key;
* **rotating the master key would make every database-stored credential undecryptable**;
* LiteLLM's own rotation endpoint (`POST /key/regenerate` with `new_master_key`), which
  re-encrypts the database, is an Enterprise feature and is not available here.

What is **not** affected by either key: virtual keys (stored as a SHA-256 hash of the key
itself — the shared `sovereign-agents` key and every `sk-os-…` system key keep working), spend,
budgets, teams, and every model defined in the chart's `model_list` (those read their
credentials from environment variables).

## What happens if a salt key simply appears

Measured on LiteLLM 1.90.0 (a database-stored model created with no salt key, then the gateway
restarted with different settings):

| Gateway restarted with | Database-stored model | Config models, virtual keys |
|---|---|---|
| `LITELLM_SALT_KEY` = **the current master key value** | works | work |
| `LITELLM_SALT_KEY` = a new random value | **gone** — the call answers 400 `Invalid model name`, and nothing in the log at INFO says why | work |
| master key **rotated**, `LITELLM_SALT_KEY` = the old master key value | works; the old master key answers 401; scoped keys still valid | work |
| back to no salt key and the original master key | works | work |

So a new random salt key does not error: it makes the stored models disappear. The data is not
lost — the old key still decrypts it — but nobody is told.

## Procedure A — pin the salt key (no re-encryption, reversible)

Use this when the master key has **not** leaked. It changes nothing about the stored data; it
only stops the master key from being the encryption key, so the master key can be rotated later.

1. **Inventory.** Admin → LLM Gateway → Models: note every model marked as stored in the
   database (`db_model: true` in `GET /model/info`). If there are none, nothing can break.
2. **Back up.** `deploy/pre-upgrade-backup.sh` (the pg dump covers the `litellm` database).
3. **Add the key to the gateway's Secret** — on STACKIT in the secrets store that External
   Secrets syncs into `litellm-credentials`, key `LITELLM_SALT_KEY`, value = **exactly the
   current value of `masterkey`**. The chart already passes that whole Secret to the gateway
   (`litellm.environmentSecrets`), so no chart change is needed.
4. **Restart the gateway** (`kubectl -n agentic-os rollout restart deploy/agentic-os-litellm`).
5. **Check**: every database-stored model from step 1 still answers
   (`POST /v1/chat/completions` with its name), and Admin → LLM Gateway still opens.

From here on **the salt key must never change** (LiteLLM's own rule). Store it as its own secret
with its own name; it is no longer "the master key".

Rollback: remove `LITELLM_SALT_KEY` from the Secret and restart. Nothing was re-encrypted.

## Procedure B — rotate the master key (after A)

1. Back up (as above).
2. Put the new master key into the secret (`litellm-credentials` key `masterkey`); the OS reads
   the same Secret (`LITELLM_MASTER_KEY`), so both change together.
3. Restart the gateway, then os-ui (`rollout restart deploy/agentic-os-litellm deploy/os-ui`).
4. Run a deploy or delete the finished `litellm-agent-key-init` Job so it re-runs with the new
   master key.
5. Check: the old master key answers 401; `GET /key/info` with the new one works; Admin → LLM
   Gateway opens (the UI session is signed with the master key, so everyone is signed out once);
   a run through the shared key and one through a system key succeed.

## Procedure C — a real re-key (the old master key leaked)

Procedure A leaves the old master key value in use as the salt key. That is fine while it is
only a retired admin credential; it is **not** fine if it leaked, because whoever has it can
decrypt the stored credentials from a database copy. Without the Enterprise rotation endpoint
the only complete answer is to re-create what is encrypted:

1. Inventory the database-stored models, credentials and MCP servers, with their plaintext
   provider credentials from your secrets store (the gateway only returns them masked).
2. Back up.
3. Delete them in the console.
4. Set a **new random** `LITELLM_SALT_KEY` and the new master key; restart gateway and os-ui.
5. Re-create the models, credentials and MCP servers; re-run the key-init Job.
6. Rotate the provider credentials themselves — they were readable with the leaked key.

Prefer keeping models in the chart's `model_list` (credentials from environment references):
those never depend on the salt key at all.

## After a gateway upgrade

The behaviour above was measured on 1.90.0. From 1.103 LiteLLM can also write new values with
AES-256-GCM (`general_settings.encryption_algorithm`), reads both formats, and still derives the
key from the salt key or, without one, the master key — so the procedures do not change. Re-run
the four-row table on the version you are about to deploy before relying on it.
