# Encryption keys for connection credentials (key providers, recovery key, restore)

Every credential a person saves on a connection (API token, OAuth token set, client secret) is
stored durably, sealed app-side with AES-256-GCM (`os-ui/core/infra/secrets.ts`, PR #334). This page
covers **who holds the key** and **how to get the credentials back after a restore**.

- Code: `os-ui/core/infra/key-manager.ts` (envelope, rotate/switch/restore), `key-providers.ts`
  (providers), `key-recovery.ts` (recovery key), `key-state.ts` (the key record)
- Admin console: **Platform → Encryption keys** (`/platform?section=encryption-keys`)
- Install wizard: setup step 2, `/onboarding/encryption` (right after the first admin account)
- Release check: `scripts/smoke-test.sh` check 11 (`scripts/lib/conn-key-check.py`)

## How it works (envelope encryption)

```
credential ──sealed with──▶ DATA KEY (random, 256 bit)
                               │
                               ├─ wrapped by the KEY PROVIDER's master key  ──▶ key record
                               └─ wrapped to the RECOVERY public key         ──▶ key record
```

- The **key record** is one Secret, `os-conn-keyring`, in the conn-secrets namespace (next to the
  credential Secrets; same Role, no new RBAC). It holds only *wrapped* data keys, the recovery-key
  **verifier** (a public key — the recovery key itself is never stored), the provider's non-secret
  config, and the provider credential *sealed* under the built-in key. Velero backs it up with the
  credentials: a backup holds ciphertext and wrapped keys, never a master key or a clear data key.
- **Providers** (`KeyProvider { id; wrap; unwrap; health }`):

  | id | master key lives | status |
  |---|---|---|
  | `builtin` (default) | Secret `os-secrets-encryption-key` in the release namespace (chart-generated, `velero.io/exclude-from-backup`) | available |
  | `stackit` | STACKIT KMS (symmetric `aes_256_gcm` key). REST routes of the official, Apache-2.0 `stackit-sdk-go` `services/kms/v1api`; no SDK dependency | available |
  | `eso` | `os-secrets-encryption-key` written by External Secrets from STACKIT Secrets Manager — GitOps installs only | available |
  | `aws-kms`, `azure-key-vault`, `gcp-kms` | — | interface-ready stubs ("not yet available"). Official SDKs are permissive (Apache-2.0 / MIT / Apache-2.0) and are added with the implementation |

  HashiCorp Vault (BSL) and OpenBao (MPL) are not offered (licence policy).
- **Bootstrap (chicken and egg).** A provider's own credential (the STACKIT service-account token)
  cannot be protected by the key it unlocks. It is sealed under the **built-in** master key, which
  therefore always exists. Where a cloud offers workload identity to pods, that replaces the stored
  credential; STACKIT SKE does not today, so the token is stored that way.
- **Locked.** If the provider cannot unwrap the data key (a rebuilt cluster has a *new* built-in key; a
  KMS token was revoked), the store is **locked**: it serves and saves nothing, `/api/status` and
  Monitoring → Platform say so (critical), and an admin unlocks it. Nothing ever silently creates a new
  key.
- **Every change** (generate/confirm recovery key, rotate, switch, unlock, test restore, test connection)
  asks for the admin's **password again** (rate-limited: 5 per 15 min) and is **audited**
  (`encryption-keys.<op>`; no key, recovery key or credential in any record). Rotate, switch and unlock
  build the new key record, **unwrap every new wrap again and compare** with the data key in memory, and
  only then write it (conditional on the version read) — a failure leaves everything as it was.
- **Monitoring** warns until a recovery key has been **confirmed** as saved, and while the provider is
  unhealthy or the store is locked.
- **Integrity.** The record carries an HMAC (under the built-in master key) over the provider id,
  config and sealed credential, the recovery verifiers and the data-key ids. Someone who can write
  Secrets in the conn-secrets namespace (or a tampered backup) cannot swap the recovery public key or
  repoint the KMS config: the record fails the check and the store is **locked**. After a restore the
  built-in key is new, so the check fails too — unlocking with the recovery key re-signs it (the typed
  key proves the verifier is genuine); unlocking with the provider credential re-signs it but **drops
  the recovery key** (its verifier cannot be authenticated) — generate a new one afterwards.
- **Missing record.** If `os-conn-keyring` is missing while credentials are sealed under data keys
  (partial restore, pods started before Velero restored it, accidental delete), key management
  **fails** with "restore os-conn-keyring" — it never mints a new key that would orphan them. Restore
  the Secret (Velero: `--include-resources secrets` for the conn-secrets namespace, or the whole
  namespace) and restart os-ui.
- **Transient vs locked.** An unreachable provider (KMS 5xx, network, 10 s timeout) is *unavailable*
  and retried automatically; only a refused unwrap, an unopenable credential or a failed integrity
  check is *locked*. A pod that already loaded its keys keeps serving through a short outage.
- **Recovery key replacement** is two-step: *Generate* stores the new verifier as *pending*; the saved
  key keeps working until someone ticks *I saved it* for the new one.
- **STACKIT token safety.** The token is only ever sent to `https://….stackit.cloud`; changing the
  provider configuration requires entering the token again. A static service-account access token
  expires — renew it in time (Unlock → *Use this credential* works while unlocked too, via *Switch
  provider* with the same settings and the new token). The STACKIT key flow (short-lived tokens from a
  service-account key) is a follow-up.
- **Fingerprints** of stored credentials are keyed by the built-in master key (not the data key), so
  they stay the same across data-key rotations.

## Install (≈ 2 minutes, part of first-run setup)

After the first admin sets a real account, the wizard asks **"Where should encryption keys live?"**

1. **Built into the OS + recovery key (recommended):** enter your password, *Generate recovery key*,
   then *Download .txt* and/or *Print / save as PDF*, store it offline (password manager, safe), tick
   *I saved the recovery key*, *Confirm*.
2. **STACKIT KMS:** create a key ring and a key (`purpose symmetric_encrypt_decrypt`, `algorithm
   aes_256_gcm`) in the STACKIT portal, and a service account with an access token allowed to use it.
   Enter project ID, region (`eu01`), key ring ID, key ID, key version and the token → *Test connection*
   → *Use STACKIT Key Management Service*. Saving a recovery key as well is still recommended.

*Skip for now* keeps the built-in key; Monitoring keeps warning, and the **prod release smoke test
fails** until a recovery key is confirmed (or the master key lives in KMS/ESO).

## Restore runbook — `builtin` provider

The Velero backup holds the credentials and the key record but **not** the built-in master key (by
design). After the restore the chart generates a new master key, so the store comes up **locked**.

1. Restore as usual (Velero; include `agentic-os` and `agentic-os-conn-secrets`).
2. Open **Platform → Encryption keys**. It shows *LOCKED*; Monitoring shows a critical alert.
3. Optional: *Test restore* with the recovery key — proves it opens every data key, changes nothing.
4. Enter your password and the recovery key → **Unlock with recovery key**. Every data key is opened
   with it, wrapped again under the new built-in master key (verified), and the record is written.
5. Within one refresh (≤ 15 s) os-ui and the worker load the keys; `/api/status` shows the store
   `ready`, and connections work. Nothing to re-enter per connection.
6. Generate a **new** recovery key if the old one was exposed during the incident, and confirm it.

If the old master key Secret was kept somewhere (e.g. an escrow copy), putting it back as
`os-secrets-encryption-key` also unlocks — no recovery key needed.

## Restore runbook — `stackit` provider

The master key never left STACKIT KMS, so the data key can be unwrapped again — but the KMS **token**
was sealed under the built-in master key, which the restore replaced.

1. Restore as usual. The store comes up **locked** (the token cannot be opened).
2. **Platform → Encryption keys → Unlock**: enter your password and the service-account token →
   **Use this credential**. It is sealed under the new built-in key and verified by unwrapping the
   data keys through KMS. (Alternatively, unlock with the recovery key.)
3. `/api/status` shows `ready`. If KMS itself refuses (key disabled/deleted — STACKIT keeps deleted
   keys recoverable for 30 days), restore the key in STACKIT first, or use the recovery key.

## Restore runbook — `eso` provider (GitOps)

The master key is in STACKIT Secrets Manager; ESO writes it back after the restore and the store
unlocks on its own once the Secret is synced (`kubectl -n agentic-os get externalsecret
os-secrets-encryption-key` → `SecretSynced`). If not: force a sync
(`kubectl annotate externalsecret os-secrets-encryption-key force-sync=$(date +%s) --overwrite`), then
check `scripts/ops/conn-key-secrets-manager.py verify`. The recovery key works here too.

Setting up `eso`: put the key into Secrets Manager once — `scripts/ops/conn-key-secrets-manager.py
create` (fresh install) or `migrate` (copy the live chart-generated key; fingerprints only, never
printed) with the writer token in a mode-600 `SM_HEADER` file (docs/ops/external-secrets-migration.md
§2) — then add `os-secrets-encryption-key` (and `os-secrets-encryption-key-previous` for rotations) to
`externalSecrets.managed`. The chart then renders no key Secret, labels the ESO-written one
`velero.io/exclude-from-backup`, and gives os-ui `OS_KEY_PROVIDER=eso`. `deploy.sh` refuses an
`eso` wiring without an ExternalSecret. The handover release is not needed for this Secret (it already
carries `helm.sh/resource-policy: keep`). `OS_KEY_PROVIDER=eso` only names the provider of the FIRST
key record: an install that started on `builtin` and later moves its master key to ESO (via
`migrate`) must also choose **Switch provider → External Secrets** in the console, so the record (and
the release check) say `eso`.

## Rotation

- **Re-wrap** (console): the provider wraps the same data key again (e.g. after a new KMS key version is
  entered in the config — switch to the same provider with the new version, or re-wrap).
- **New data key** (console): credentials are re-sealed under it in the background on each refresh;
  the old data key stays decrypt-only (`sealedUnderPreviousKey` counts down to 0).
- **Built-in / ESO master key**: put the old value into `OS_SECRETS_ENCRYPTION_KEY_PREVIOUS`
  (`osUI.connectionSecrets.previousKeysSecret`, or `conn-key-secrets-manager.py rotate` for ESO), set the
  new key, restart os-ui and the worker: the key manager unwraps with the retired key and re-wraps every
  data key under the new one by itself (history `rotate.master-key`). Then remove the previous key.
- **Switch provider** (console): test connection → *Use …*; every data key is re-wrapped and verified
  before the switch is saved.

## Release check (prod)

`scripts/smoke-test.sh` (run by `scripts/release.sh`) reads only the key record's annotations
(`sovereign-os.io/key-provider`, `sovereign-os.io/recovery-confirmed`) and FAILS a prod release when the
master key is `builtin` and no recovery key is confirmed. Override: `--allow-unrecoverable-conn-key`
(release.sh / smoke-test.sh / deploy.sh) or `ALLOW_UNRECOVERABLE_CONN_KEY=1`. First prod release of this
feature: deploy, confirm the recovery key in the console, re-run the smoke test (or release once with
the override).

## Fingerprints differ (`conn-key-secrets-manager.py migrate` refused)

The vault already holds a different key than the live Secret. Do **not** let ESO own the Secret until
resolved: the key record's data keys are wrapped under the *live* key. Find out who wrote the vault copy;
if it is stale, delete it in Secrets Manager and run `migrate` again.
