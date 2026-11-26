# Encryption keys for connection credentials (key providers, recovery choice, restore)

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
- **Every change** (recovery choice, generate/confirm recovery key, rotate, switch, unlock, start over,
  test restore, test connection) is **admin-only on the server** (the route's admin session, and the
  operation itself refuses any other role with `403 forbidden`, audited),
  needs a **fatal OPA decision** (`authorize('user:<id>', 'admin')`), asks for the admin's **password
  again** (rate-limited: 5 per 15 min — an in-process limiter, which holds because the chart runs ONE
  os-ui replica; scaling os-ui out multiplies it, so move it to the shared store first) and is **audited**
  (`encryption-keys.<op>`; no key, recovery key or credential in any record). Rotate, switch and unlock
  build the new key record, **unwrap every new wrap again and compare** with the data key in memory, and
  only then write it (conditional on the version read) — a failure leaves everything as it was.
- **Monitoring** warns until an admin has made the **recovery choice** (below), and while the provider is
  unhealthy or the store is locked.
- **Integrity.** The record carries an HMAC (under the built-in master key) over the provider id,
  config and sealed credential, the recovery verifiers **including when/by whom the recovery key was
  confirmed**, and the data-key ids. Someone who can write
  Secrets in the conn-secrets namespace (or a tampered backup) cannot swap the recovery public key or
  repoint the KMS config: the record fails the check and the store is **locked**. After a restore the
  built-in key is new, so the check fails too — unlocking with the recovery key re-signs it (the typed
  key proves the verifier is genuine); unlocking with the provider credential re-signs it but **drops
  the recovery key** (its verifier cannot be authenticated) — generate a new one afterwards.
- **Missing record.** If `os-conn-keyring` is missing while credentials are sealed under data keys
  (partial restore, pods started before Velero restored it, accidental delete), key management
  **fails** with "restore os-conn-keyring" — it never mints a new key that would orphan them. Restore
  the Secret (see *Restore order* below) and restart os-ui. Values sealed under a key id that neither the
  record nor the built-in key knows are counted (`unknownKey` in Platform → Encryption keys and the
  in-cluster summary) and raise
  a **critical Monitoring alert** — never guessed at.
- **Transient vs locked.** An unreachable provider (KMS 5xx, network, 10 s timeout) is *unavailable*
  and retried automatically; only a refused unwrap, an unopenable credential or a failed integrity
  check is *locked*. A pod that already loaded its keys keeps serving through a short outage.
- **Recovery choice (owner decision 2026-11-26).** A recovery key is an **option, not a requirement**: an
  exported key that opens every connection is itself a risk, and connections can be restored without it —
  API keys are re-entered, OAuth connections (Microsoft 365, Google) are signed into again. Under
  **Platform → Encryption keys → Recovery** an admin picks one:
  - **No recovery key** — one plain acknowledgement ("if the cluster's key is lost, stored connection
    credentials can't be decrypted and connections must be reconnected"). Who chose it and when is signed
    into the key record (`recovery.none` in its history) and written to the audit log
    (`encryption-keys.recovery-none`). Choosing it while a recovery key exists **removes** that key's
    verifier and every recovery wrap from the record. A copy exported earlier no longer opens the live
    record, but it **still opens backups taken before the change** (they hold the old wraps and the same
    data key) until the data key is replaced: **Rotate → New data key**, then the retired key is dropped
    after its grace period. The console says this when you switch.
  - **Recovery key** — the existing flow, unchanged (generate → save offline → type it back → confirm).
    Confirming records the "Recovery key" choice.

  A **new install has no recovery key and no choice**: the choice reads *not made* until an admin
  confirms one of the two. External KMS/Vault as a third way to keep the key out of the cluster is a later
  step (the STACKIT KMS provider exists; others are stubs).
- **Start over (master key lost, nothing to unlock with).** With "No recovery key", a lost master key leaves
  the record **locked** with nothing to unlock it. *Start over with new keys* (password + acknowledgement;
  audited as `encryption-keys.reset-keys`, history `reset.lost-key`) writes a new key record with a new
  data key. It is offered and allowed **only** when the lock really is a lost built-in master key:
  - os-ui re-reads the record immediately before, and decides on that fresh copy only;
  - the record's provider is `builtin`, it verifies under **no** configured master key, and **none** of its
    data keys opens with one (if this process's key still opens them, the record was altered — restore it
    from a backup instead). A refusing or misconfigured KMS, an expired provider credential or a failed
    check on a non-builtin record are recoverable (new credential, recovery key) and are refused;
  - **no other OS process opened that same record in the last 10 minutes.** Every process that holds the
    keys leaves a small marker (`os-conn-keyring-seen-*` Secrets in the conn-secrets namespace, label
    `app.kubernetes.io/component=connection-keyring-seen`; a process id, a time and which record — no key
    material). A recent marker means the record is healthy and *this* process has an out-of-date
    `OS_SECRETS_ENCRYPTION_KEY`: restart it instead. (So a start-over right after a restore may have to
    wait until restored markers are 10 minutes old.);
  - a record that still holds a recovery key needs an extra, explicit override — unlock with the recovery
    key if you have it. The override is its own audit record (`encryption-keys.reset-keys.recovery-override`).

  The previous record is **archived inside the new one** (`archive`, the last 3; its wrapped data keys,
  recovery verifier and wraps and provider entry, still wrapped — no clear key), so a master key or
  recovery key found later can still open the values sealed under it (by hand today; an archive-unlock
  operation is a follow-up; it must verify each archived entry's own signature under the key that was found
  before trusting anything in it — the entries come from a record that could not be verified). The original
  (oldest) archived record is never evicted: the archive keeps it plus the two most recent. History carried
  over from the unverifiable record is shown as *unverified*.
- **Seen markers** are pruned when listed (and once at each process start): markers older than 24 hours are
  deleted, so one Secret per pod start does not pile up. If a process cannot write its marker, Monitoring →
  Platform and the health warning say so — fix that before anyone starts over, because for a process with
  an out-of-date key the other processes' markers are the only guard.
- **Rollback safety.** Confirming a recovery key writes nothing new into the key record (the "Recovery key"
  choice is derived from the confirmed recovery key), so an os-ui from before the recovery choice still
  verifies it. Choosing **"No recovery key"** and **Start over** add signed fields (`recoveryChoice`,
  `archive`) that older os-ui versions do not know: after either, **rolling os-ui back to a version from
  before this change locks the stored credentials until it is rolled forward again** (the record is fine;
  the older build cannot verify it). Treat both as one-way for rollback purposes, and finish a rollout
  (no old and new os-ui pods side by side) before using them. Values sealed under the old data keys are never guessed at: they count as
  `unknownKey`, and every affected connection shows **Needs reconnect** in Connections (and in Monitoring →
  Platform) with its *Reconnect* action — the owner re-enters the API key or signs in again, which
  overwrites the old value. The recovery choice has to be made again afterwards. While the record is
  merely locked, connections are **not** marked: an admin may still unlock it with a recovery key or the
  provider credential, and saving a credential is refused until then.
- **Recovery key replacement** is two-step: *Generate* stores the new verifier as *pending*; the saved
  key keeps working until someone confirms the new one. **Confirming means typing the key back** from
  the saved copy (and ticking *I saved it*): the confirmation is bound to the key that person saw — a
  second tab that generated another key cannot be confirmed with the first one's.
- **STACKIT token safety.** The token is only ever sent to `https://….stackit.cloud`; changing the
  provider configuration requires entering the token again. A static service-account access token
  expires — renew it in time (Unlock → *Use this credential* works while unlocked too, via *Switch
  provider* with the same settings and the new token). The STACKIT key flow (short-lived tokens from a
  service-account key) is a follow-up.
- **Fingerprints** of stored credentials are keyed by the built-in master key (not the data key), so
  they stay the same across data-key rotations. They **do change after a restore** that brought a new
  built-in key (display only — nothing compares them across restores).
- **Egress.** os-ui and the worker reach `kms.api.stackit.cloud` over the chart's direct-HTTPS egress
  (`networkPolicies.directHttpsEgress`, public 443) — not the egress proxy; nothing to add there.
- **Migration window #334 → this.** Values #334 sealed directly under `OS_SECRETS_ENCRYPTION_KEY` stay
  readable (that key is a decrypt-only legacy key) and are re-sealed under the data key on the first
  refresh after the upgrade; retired data keys are then pruned once no value uses them. Do not change
  the built-in key during that first boot.

## First admin and the policy engine (known race)

Every key operation needs OPA to allow `user:<id>` the `admin` tool. Right after first-run setup the new
admin may not be in OPA's data yet (the compiled grants reach OPA when a Platform-Admin route recompiles).
The encryption-keys route handles that: on `opa-deny` it recompiles the policy from the identity source —
what the other admin routes do on every change — and asks OPA once more. If OPA still refuses (or is not
reachable), the wizard and the console say so in plain words ("the policy engine has not confirmed your
admin rights yet … try again"), the refusal is audited (`encryption-keys.denied`), and nothing changed.
Waiting a few seconds and retrying is normal; if it persists, check the admin grant in Governance → Policy
and OPA in Monitoring → Platform. Skipping the wizard step is safe — the built-in key works at once.

## Install (≈ 2 minutes, part of first-run setup)

After the first admin sets a real account, the wizard asks **"Where should encryption keys live?"**

1. **Built into the OS (recommended)**, then the **recovery choice**: enter your password and either
   - *No recovery key* → tick the acknowledgement → *Confirm: no recovery key*; or
   - *Recovery key* → *Generate recovery key*, then *Download .txt* and/or *Print / save as PDF*, store it
     offline (password manager, safe), tick *I saved the recovery key*, **type the key back** from your
     saved copy, *Confirm*.
2. **STACKIT KMS:** create a key ring and a key (`purpose symmetric_encrypt_decrypt`, `algorithm
   aes_256_gcm`) in the STACKIT portal, and a service account with an access token allowed to use it.
   Enter project ID, region (`eu01`), key ring ID, key ID, key version and the token → *Test connection*
   → *Use STACKIT Key Management Service*. Then make the recovery choice as above (a recovery key also
   opens the credentials if the KMS key or its access is lost).

*Skip for now* keeps the built-in key; Monitoring keeps warning, and the **prod release smoke test
fails** until the recovery choice is made (either option; with the master key in KMS/ESO a missing choice
is only a note).

## Restore order (all providers)

Restore `os-conn-keyring` **before os-ui first boots** on the restored cluster: run the Velero restore
of `agentic-os-conn-secrets` (and `agentic-os`) first, then install/upgrade the release. If os-ui is
already running, restore that Secret with `velero restore create … --existing-resource-policy=update`
(Velero skips objects that exist by default), then restart os-ui and the worker. os-ui refuses to create
a new key record while credentials sealed under data keys exist, so a wrong order shows up as *failed*
("restore os-conn-keyring") plus a critical alert — never as silently lost credentials.

## Restore runbook — `builtin` provider

The Velero backup holds the credentials and the key record but **not** the built-in master key (by
design). After the restore the chart generates a new master key, so the store comes up **locked**.

1. Restore as usual (Velero; include `agentic-os` and `agentic-os-conn-secrets`; *Restore order* above).
2. Open **Platform → Encryption keys**. It shows *LOCKED*; Monitoring shows a critical alert.
3. Optional: *Test restore* with the recovery key — proves it opens every data key, changes nothing.
4. Enter your password and the recovery key → **Unlock with recovery key**. Every data key is opened
   with it, wrapped again under the new built-in master key (verified), and the record is written.
5. Within one refresh (≤ 15 s) os-ui and the worker load the keys; `/api/status` shows the store
   `ready`, and connections work. Nothing to re-enter per connection.
6. Generate a **new** recovery key if the old one was exposed during the incident, and confirm it.

If the old master key Secret was kept somewhere (e.g. an escrow copy), putting it back as
`os-secrets-encryption-key` also unlocks — no recovery key needed.

**No recovery key (and no escrow copy):** the stored credentials cannot be opened again. Enter your
password, tick the acknowledgement and choose **Start over with new keys**. Connections work again as soon
as their owners reconnect them (each shows *Needs reconnect*); then make the recovery choice again.

## Restore runbook — `stackit` provider

The master key never left STACKIT KMS — but the KMS **token** was sealed under the built-in master key,
which the restore replaced. Two ways back:

1. Restore as usual (*Restore order* above). The store comes up **locked** (the token cannot be opened).
2. **A — KMS still works:** Platform → Encryption keys → Unlock → enter your password and the
   service-account token → **Use this credential**. It is sealed under the new built-in key and verified
   by unwrapping the data keys through KMS. (This re-signs the record but drops the recovery key, whose
   verifier cannot be authenticated without the old built-in key — generate a new one afterwards.)
3. **B — KMS key deleted, access revoked, or simply faster:** enter the **recovery key** → **Unlock with
   recovery key**. The data keys are opened with it; if STACKIT KMS passes a live test they stay there,
   otherwise they move to the **built-in** key (the history and the result say so) — but only on a
   LASTING failure (token refused, key deleted or misconfigured, token unopenable). If KMS is merely
   **unreachable** right now, unlock refuses ("unreachable — retry, or pick a provider explicitly") rather
   than downgrading the installation. Tick *Move the data
   keys to the built-in key* to choose that explicitly. Later, *Switch provider* back to STACKIT once a
   working key and token exist.
4. `/api/health` shows `connectionKeys: ok` (details: Platform → Encryption keys). STACKIT keeps deleted keys recoverable for 30 days
   — restoring the KMS key is an alternative to B.

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
  the old data key stays decrypt-only (`sealedUnderPreviousKey` counts down to 0). A retired data key
  is dropped from the record only when **no stored value uses it AND its grace period has passed**
  (`OS_KEY_RETIRED_GRACE_DAYS`, default 7, counted from when the key that replaced it was created): a pod
  that still holds the old keyring (the worker reloads the record on every refresh, ≤ 15 s, but one whose
  record reads keep failing keeps the keys it has) may still write under it, and those values must stay
  readable.
- **Built-in / ESO master key**: put the old value into `OS_SECRETS_ENCRYPTION_KEY_PREVIOUS`
  (`osUI.connectionSecrets.previousKeysSecret`, or `conn-key-secrets-manager.py rotate` for ESO), set the
  new key, restart os-ui and the worker: the key manager unwraps with the retired key and re-wraps every
  data key under the new one by itself (history `rotate.master-key`). Then remove the previous key.
- **Switch provider** (console): test connection → *Use …*; every data key is re-wrapped and verified
  before the switch is saved.

## Release check (prod)

`scripts/smoke-test.sh` (run by `scripts/release.sh`) reads os-ui's own verdict `{status, provider,
recovery, recoveryChoice}`, computed from the key record os-ui VERIFIED (HMAC) — not from any annotation someone could
edit — **in-cluster**: `kubectl exec` into os-ui, `GET http://127.0.0.1:3000/api/platform-admin/encryption-keys?summary=1`
with the service bearer the pod already holds (`AGENT_RUNTIME_TOKEN`; never printed). The
unauthenticated `/api/health` only says `connectionKeys: ok | degraded` — which provider runs and whether
a recovery key exists are not published. It FAILS a prod release when
the keys are not `ready`, or the master key is `builtin` and **no recovery choice was made**
(`recoveryChoice: unset`). Either choice passes: `none` (an admin confirmed "No recovery key") or
`recovery-key` (a recovery key confirmed as saved); an os-ui older than the choice sends no
`recoveryChoice`, and then a confirmed recovery key counts. The message names where to choose:
Platform → Encryption keys → Recovery. Override: `--allow-unrecoverable-conn-key`
(release.sh / smoke-test.sh / deploy.sh) or `ALLOW_UNRECOVERABLE_CONN_KEY=1`. First prod release of this
feature: deploy, make the recovery choice in the console, re-run the smoke test (or release once with
the override).

From GitHub Actions: the `prod` workflow's `allow_unrecoverable_conn_key` input (boolean, default off)
passes `--allow-unrecoverable-conn-key` to `release.sh --phase deploy`. Tick it only for that first release;
it is passed as the flag, never as an env value, because any non-empty `ALLOW_UNRECOVERABLE_CONN_KEY`
(even `false`) turns the override on. It also turns deploy.sh's key-wiring refusal
(`CONN_KEY_WIRING_REFUSED`) into a warning, so check that render step's output in the run log.

## Fingerprints differ (`conn-key-secrets-manager.py migrate` refused)

The vault already holds a different key than the live Secret. Do **not** let ESO own the Secret until
resolved: the key record's data keys are wrapped under the *live* key. Find out who wrote the vault copy;
if it is stale, delete it in Secrets Manager and run `migrate` again.
