/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Envelope key management for connection credentials — data keys, provider, recovery, rotate, switch, restore
 * USER STORY: As an admin I see where the master key lives and whether it is healthy, I save a recovery
 *             key once, I can rotate keys or move them to STACKIT KMS without losing a credential, and
 *             after a disaster I type the recovery key and everything is readable again.
 * ARCHITECTURE:
 *   - Credentials are sealed (secret-crypto.ts) under the CURRENT DATA KEY; retired data keys stay
 *     in the keyring (decrypt-only) until the store has re-sealed every value. The keyring a pod
 *     uses = data keys (current first) + the LEGACY env-derived keys (values PR #334 sealed directly
 *     under OS_SECRETS_ENCRYPTION_KEY before envelope encryption — re-sealed on the first refresh).
 *   - The key RECORD (key-state.ts) holds each data key wrapped by the active PROVIDER
 *     (key-providers.ts) and, once a recovery key exists, wrapped to the recovery public key
 *     (key-recovery.ts). First boot creates it (provider `builtin`, or OS_KEY_PROVIDER=eso for a
 *     GitOps install) with a conditional create, so os-ui and the worker never mint two.
 *   - LOCKED: a record whose data keys the provider cannot unwrap (a restored cluster has a NEW
 *     builtin master key; a KMS token expired). The store then serves and saves nothing and says
 *     so; the admin unlocks with the recovery key (re-wrapped under the current provider) or by
 *     re-entering the provider credential. Never a guess, never a silent new key.
 *   - EVERY CHANGE IS VERIFIED BEFORE COMMIT: rotate / switch / restore build the new record, unwrap
 *     each wrap they just made and compare with the data key in memory, and only then write it
 *     (conditional on the version read). Any failure leaves the stored record — and this pod's
 *     keys — exactly as they were (that IS the rollback).
 *   - Re-authentication and audit are the admin route's job (app/api/platform-admin/encryption-keys);
 *     every operation here takes the actor and appends a material-free history entry.
 *   - Health: one warning (`connection-keys`) while locked, a provider fails, or the recovery key is
 *     missing/unconfirmed; `connectionKeyAlerts()` feeds Monitoring → Platform.
 *   - INTEGRITY: the record carries an HMAC (under the builtin master key) over provider id/config/
 *     credential, the recovery verifiers and the data-key ids; a record that fails it is LOCKED (a
 *     restore changed the master key, or someone altered it). A MISSING record while credentials are
 *     sealed under data keys is a hard failure — never a fresh key that would orphan them.
 *   - TRANSIENT vs LOCKED: a provider that is unreachable (KMS 5xx, network, 10 s timeout) is
 *     `unavailable` and retried; only a refused unwrap / credential / integrity check is `locked`. A
 *     failed keyring read after a good load keeps serving the keys already held.
 *   - RECOVERY KEY: generated as PENDING and swapped in only on "I saved it", so a lost dialog never
 *     invalidates the recovery key already saved.
 *   - RECOVERY CHOICE (owner decision 2026-11-26): a recovery key is an OPTION, not a requirement — an
 *     exported key that opens every connection is itself a risk. The admin explicitly picks "No recovery
 *     key" (`chooseNoRecoveryKey`: acknowledged, signed into the record, drops any recovery verifier and
 *     wraps) or "Recovery key" (the confirm flow). A new install has NO choice (`unset`): Monitoring warns
 *     and the prod release check fails until one is made. With "none", a lost master key leaves the record
 *     LOCKED with nothing to unlock it: `resetLockedKeys` starts over with a new data key (acknowledged);
 *     the old values become unreadable and their connections read `needs-reconnect`.
 *   - START-OVER GUARDS (security review of PR #376): a start-over is allowed ONLY when this process has
 *     just re-read the record (fresh `loadKeys`), it is LOCKED for the one unrecoverable reason — a
 *     `builtin` record that verifies under NO configured master key AND none of whose data keys any
 *     configured key opens (`lockCause: 'key-mismatch'`; a record our key still opens was ALTERED, not
 *     orphaned — restore it instead) — and NO OTHER PROCESS opened that very record recently (the seen
 *     markers, `KeySeenEntry`, ≤ 10 min): otherwise the record is healthy and THIS process holds the wrong
 *     master key, and resetting would lock every healthy process. A KMS that refuses or is misconfigured, a
 *     changed provider credential, or an integrity failure on a non-builtin record stay recoverable (new
 *     credential, recovery key) and are refused. A record that holds a recovery key needs an explicit,
 *     separately audited override. The previous record is ARCHIVED inside the new one (still wrapped), never
 *     discarded.
 *   - No `server-only`: unit-tested with a memory key store and mock providers (key-manager.test.ts).
 */
import { randomBytes } from 'crypto';
import { clearHealthWarning, setHealthWarning } from '@core/infra/health-warnings';
import { deriveSecretKey, type Keyring, type SecretKey } from '@core/infra/secret-crypto';
import { SecretConflictError } from '@core/infra/secret-backend';
import {
  createKeyProvider,
  KeyProviderError,
  openProviderCredential,
  openProviderCredentialWith,
  providerInfo,
  recordMacMaterial,
  sealProviderCredential,
  signRecordMac,
  verifyRecordMac,
  type KeyProvider,
  type KeyProviderId,
  type ProviderHealth,
} from '@core/infra/key-providers';
import { newRecoveryKey, recoveryKeyMatches, recoveryVerifier, unwrapWithRecovery, wrapForRecovery } from '@core/infra/key-recovery';
import type { KeyRecord, KeyStateStore, WrappedDataKey } from '@core/infra/key-state';
import { stackitKmsCall, type FetchLike, type KmsCall } from '@core/adapters/stackit-kms/client';

export const KEYS_HEALTH = 'connection-keys';
export const KEY_PROVIDER_ENV = 'OS_KEY_PROVIDER';
/** Days a retired data key is kept after it was replaced, even when no stored value uses it (default 7). */
export const KEY_GRACE_ENV = 'OS_KEY_RETIRED_GRACE_DAYS';
const HISTORY_MAX = 50;

export type KeyStatus = 'unconfigured' | 'ready' | 'unavailable' | 'locked' | 'failed';
export type RecoveryState = 'missing' | 'unconfirmed' | 'confirmed';
/** The admin's explicit recovery choice: `unset` until an admin confirms one of the two options. */
export type RecoveryChoice = 'unset' | 'none' | 'recovery-key';

type Deps = {
  store: KeyStateStore;
  env: NodeJS.ProcessEnv;
  kms: KmsCall;
  legacy: SecretKey[];
  /** The key ids the stored credentials are sealed under (the credential backend's listing) — guards first boot. */
  sealedKeyIds?: () => Promise<string[]>;
  /** This process's identity for the seen markers (pod name; tests simulate several pods). */
  processId: string;
  /** The clock for the seen markers and their freshness window (tests inject a fixed one). */
  now: () => number;
};
const DEFAULT_PROCESS_ID = `${process.env.HOSTNAME || 'os-ui'}:${randomBytes(4).toString('hex')}`;
type State = {
  deps: Deps | null;
  status: KeyStatus;
  reason: string;
  record: KeyRecord | null;
  version: string | null;
  /** Clear data keys, by id — in memory only, never persisted, never logged. */
  keys: Map<string, Buffer>;
  lastHealth: (ProviderHealth & { at: string }) | null;
  loading: Promise<void> | null;
  /** Bumped by every commit here: a load that started before it must not roll this pod back. */
  gen: number;
  /** Why the record is locked (null unless locked). Only `key-mismatch` can be started over. */
  lockCause: LockCause | null;
  /** Throttle for this process's seen marker. */
  lastSeen: { mac: string; at: number } | null;
  /** The last marker write failed (null when the last one succeeded) — a health warning. */
  seenError: string | null;
  /** Old markers are pruned once per process, on its first write. */
  seenPruned: boolean;
};

/** `key-mismatch`: a builtin record no configured key verifies or opens (the master key is gone). `tampered`:
 *  our key opens its data keys but the signature fails (altered). `integrity`: a non-builtin record failed
 *  its signature. `unwrap`: the provider refused / is misconfigured / a credential cannot be opened. */
export type LockCause = 'key-mismatch' | 'tampered' | 'integrity' | 'unwrap';
/** Another process that opened the record within this window blocks a start-over. */
export const SEEN_FRESH_MS = 10 * 60_000;
const SEEN_EVERY_MS = 60_000;

const KEY = Symbol.for('soa.secrets.keys');
function st(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  return (g[KEY] ??= { deps: null, status: 'unconfigured', reason: '', record: null, version: null, keys: new Map(), lastHealth: null, loading: null, gen: 0, lockCause: null, lastSeen: null, seenError: null, seenPruned: false });
}

export class KeyOperationError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'KeyOperationError';
  }
}

const now = () => new Date().toISOString();
const idOf = (dek: Buffer) => deriveSecretKey(dek.toString('base64')).id;

/** Wire the key manager (secrets.ts on configure; tests with a memory store). Resets this process's keys. */
export function configureKeyManager(deps: { store: KeyStateStore; env?: NodeJS.ProcessEnv; fetch?: FetchLike; legacy?: SecretKey[]; sealedKeyIds?: () => Promise<string[]>; processId?: string; now?: () => number }): void {
  const s = st();
  s.deps = { store: deps.store, env: deps.env ?? process.env, kms: stackitKmsCall(deps.fetch), legacy: deps.legacy ?? [], sealedKeyIds: deps.sealedKeyIds, processId: deps.processId ?? DEFAULT_PROCESS_ID, now: deps.now ?? Date.now };
  s.lockCause = null;
  s.lastSeen = null;
  s.seenError = null;
  s.seenPruned = false;
  s.status = 'unconfigured';
  s.reason = '';
  s.record = null;
  s.version = null;
  s.keys = new Map();
  s.lastHealth = null;
  s.loading = null;
}

function deps(): Deps {
  const d = st().deps;
  if (!d) throw new KeyOperationError(503, 'the key manager is not configured');
  return d;
}

function providerFor(record: KeyRecord): KeyProvider {
  const d = deps();
  const cred = record.provider.credential ? openProviderCredential(d.env, record.provider.id, record.provider.credential) : undefined;
  return createKeyProvider(record.provider.id, record.provider.config ?? {}, cred, { env: d.env, kms: d.kms });
}

function recoveryState(r: KeyRecord | null): RecoveryState {
  if (r?.recovery?.confirmedAt) return 'confirmed';
  return r?.pendingRecovery ? 'unconfirmed' : 'missing';
}

/** `none` when an admin chose it; `recovery-key` while a CONFIRMED recovery key exists; otherwise `unset`. */
function recoveryChoiceOf(r: KeyRecord | null): RecoveryChoice {
  if (r?.recoveryChoice?.mode === 'none') return 'none';
  return recoveryState(r) === 'confirmed' ? 'recovery-key' : 'unset';
}

function signed(r: KeyRecord): KeyRecord {
  const { mac: _old, ...rest } = r;
  void _old;
  return { ...rest, mac: signRecordMac(deps().env, recordMacMaterial(rest)) };
}
function macState(r: KeyRecord): 'current' | 'previous' | 'invalid' {
  return verifyRecordMac(deps().env, recordMacMaterial(r), r.mac);
}
/** A refused unwrap / credential / integrity failure locks; an unreachable provider (or a plain network error) is transient. */
function isTransient(e: unknown): boolean {
  return e instanceof KeyProviderError ? e.code === 'unreachable' : false;
}

function publish(): void {
  const s = st();
  const parts: string[] = [];
  if (s.status === 'locked') parts.push(`stored credentials are LOCKED — the ${s.record?.provider.id ?? ''} key provider cannot unwrap the data key (${s.reason}). An admin unlocks them under Platform → Encryption keys (recovery key, or re-enter the provider credential)`);
  if (s.status === 'failed') parts.push(`key management failed: ${s.reason}`);
  if (s.status === 'unavailable') parts.push(`the key provider or key record is not answering — retrying; credentials cannot be read or saved until it does: ${s.reason}`);
  const unset = s.status === 'ready' && recoveryChoiceOf(s.record) === 'unset';
  if (unset && recoveryState(s.record) === 'missing') parts.push('no recovery choice made: no recovery key has been saved and "No recovery key" was not confirmed — choose one under Platform → Encryption keys → Recovery');
  if (unset && recoveryState(s.record) === 'unconfirmed') parts.push('the recovery key was generated but nobody confirmed saving it — confirm it, or choose "No recovery key" (Platform → Encryption keys → Recovery)');
  if (s.lastHealth && !s.lastHealth.ok) parts.push(`key provider unhealthy: ${s.lastHealth.detail}`);
  if (s.seenError) parts.push(`this process cannot record that it holds the keys (seen marker): ${s.seenError} — the guard against a wrong-key "start over" is weakened until this works`);
  if (parts.length) setHealthWarning(KEYS_HEALTH, `Encryption keys: ${parts.join(' | ')}`);
  else clearHealthWarning(KEYS_HEALTH);
}

async function unwrapAll(record: KeyRecord, provider: KeyProvider): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (const k of record.dataKeys) {
    const dek = await provider.unwrap(k.wrapped, k.id);
    if (idOf(dek) !== k.id) throw new KeyProviderError('unwrap-failed', `data key ${k.id}: unwrapped to another key`);
    out.set(k.id, dek);
  }
  return out;
}

async function initialRecord(): Promise<KeyRecord> {
  const d = deps();
  const chosen = (d.env[KEY_PROVIDER_ENV] ?? '').trim() || 'builtin';
  if (chosen !== 'builtin' && chosen !== 'eso') {
    throw new KeyProviderError('misconfigured', `${KEY_PROVIDER_ENV}=${chosen}: only builtin or eso can be the first provider; choose another one in Platform → Encryption keys`);
  }
  const provider = createKeyProvider(chosen, {}, undefined, { env: d.env, kms: d.kms });
  const dek = randomBytes(32);
  const id = idOf(dek);
  return signed({
    v: 1,
    provider: { id: chosen, config: {} },
    dataKeys: [{ id, wrapped: await provider.wrap(dek, id), provider: chosen, createdAt: now() }],
    history: [{ at: now(), actor: 'system', action: 'init', detail: `first data key ${id}, provider ${chosen}` }],
    updatedAt: now(),
  });
}

/**
 * Mark "this process opened the record" (throttled). NOT harmless when it fails: for a pod that holds the
 * WRONG master key, the healthy pods' markers are the ONLY thing that stops it from starting over over a
 * healthy record. So a failed write is a health warning (Monitoring → Platform, /api/status) until a write
 * succeeds again — fix the conn-secrets Role / API access before anyone starts over.
 */
function noteSeen(): void {
  const s = st();
  const store = s.deps?.store;
  const mac = s.record?.mac;
  if (s.status !== 'ready' || !store?.seen || !mac) return;
  const nowMs = deps().now();
  if (s.lastSeen && s.lastSeen.mac === mac && nowMs - s.lastSeen.at < SEEN_EVERY_MS) return;
  s.lastSeen = { mac, at: nowMs };
  const seen = store.seen;
  void seen.write({ process: deps().processId, at: new Date(nowMs).toISOString(), mac }).then(
    () => {
      if (st().seenError !== null) {
        st().seenError = null;
        publish();
      }
      // First successful write of this process: prune old markers (listing deletes those > 24 h).
      if (!st().seenPruned) {
        st().seenPruned = true;
        void seen.list().then(
          () => undefined,
          (e) => console.warn(`[keys] pruning old seen markers failed (retried on the next list): ${e instanceof Error ? e.message : String(e)}`),
        );
      }
    },
    (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[keys] could not write this process's seen marker: ${msg}`);
      st().seenError = msg;
      st().lastSeen = null; // retry on the next load
      publish();
    },
  );
}

/** Does any configured key open any of this record's data keys? (builtin/eso only). A provider that cannot
 *  even be built (no usable env key) opens nothing — that IS the answer, not a substituted one. */
async function anyDataKeyOpens(record: KeyRecord): Promise<boolean> {
  if (record.provider.id !== 'builtin' && record.provider.id !== 'eso') return false;
  const provider = createKeyProvider(record.provider.id, {}, undefined, { env: deps().env, kms: deps().kms });
  const tries = await Promise.allSettled(record.dataKeys.map((k) => provider.unwrap(k.wrapped, k.id)));
  return tries.some((t) => t.status === 'fulfilled');
}

/** Read (or create) the key record and unwrap its data keys. Idempotent; re-unwraps only when the record changed. */
export async function loadKeys(): Promise<void> {
  const s = st();
  if (s.loading) return s.loading;
  s.loading = (async () => {
    const d = deps();
    const gen = s.gen;
    const wasReady = s.status === 'ready';
    const transient = (why: string) => {
      // After a good load keep serving the keys already held; before one, say so and retry.
      if (wasReady) console.error(`[keys] ${why} — keeping the keys already loaded`);
      else {
        s.status = 'unavailable';
        s.reason = why;
        console.error(`[keys] ${why}`);
      }
    };
    try {
      let cur;
      try {
        cur = await d.store.read();
      } catch (e) {
        transient(`key record unreadable: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      if (!cur) {
        // NEVER mint a new data key over credentials sealed under one the record held (a partial restore,
        // pods starting before Velero restored the record, an accidental delete): that orphans them all.
        let ids: string[] = [];
        try {
          ids = d.sealedKeyIds ? await d.sealedKeyIds() : [];
        } catch (e) {
          transient(`cannot check the stored credentials before creating the key record: ${e instanceof Error ? e.message : String(e)}`);
          return;
        }
        const legacy = new Set(d.legacy.map((k) => k.id));
        const orphaned = ids.filter((id) => !legacy.has(id));
        if (orphaned.length) {
          s.status = 'failed';
          s.reason = `the key record os-conn-keyring is missing, but ${orphaned.length} stored credential(s) are sealed under data keys it held — restore os-conn-keyring (e.g. from the Velero backup); a new key would make them unreadable`;
          console.error(`[keys] ${s.reason}`);
          return;
        }
        const rec = await initialRecord();
        try {
          const { version } = await d.store.write(rec, null);
          cur = { record: rec, version };
        } catch (e) {
          if (!(e instanceof SecretConflictError)) throw e;
          cur = await d.store.read(); // the other pod created it first
          if (!cur) throw e;
        }
      }
      if (s.gen !== gen) return; // a commit in this process is newer than what we read
      if (cur.version === s.version && s.status === 'ready') {
        noteSeen();
        return;
      }
      const integrity = macState(cur.record);
      if (integrity === 'invalid') {
        // Orphaned (no configured key opens anything) or altered (our key opens it, the signature fails)?
        // A builtin provider that cannot be built here (no usable OS_SECRETS_ENCRYPTION_KEY) is 'integrity' — not
        // eligible for a start-over: fix the env key first.
        let cause: LockCause = 'integrity';
        if (cur.record.provider.id === 'builtin') {
          try {
            cause = (await anyDataKeyOpens(cur.record)) ? 'tampered' : 'key-mismatch';
          } catch (e) {
            console.error(`[keys] cannot check the locked record against this process's master key: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        if (s.gen !== gen) return;
        s.record = cur.record;
        s.version = cur.version;
        s.keys = new Map();
        s.lockCause = cause;
        s.status = 'locked';
        s.reason = 'the key record failed its integrity check (the builtin master key changed — e.g. after a restore — or the record was altered)';
        console.error(`[keys] connection-credential data key LOCKED: ${s.reason}`);
        return;
      }
      let provider: KeyProvider;
      let keys: Map<string, Buffer>;
      let credCurrent = true;
      try {
        if (cur.record.provider.credential) credCurrent = openProviderCredentialWith(d.env, cur.record.provider.id, cur.record.provider.credential).current;
        provider = providerFor(cur.record);
        keys = await unwrapAll(cur.record, provider);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isTransient(e)) {
          transient(`the ${cur.record.provider.id} key provider is not answering: ${msg}`);
          return;
        }
        s.record = cur.record;
        s.version = cur.version;
        s.keys = new Map();
        s.lockCause = 'unwrap';
        s.status = 'locked';
        s.reason = msg;
        console.error(`[keys] connection-credential data key LOCKED (${cur.record.provider.id}): ${msg}`);
        return;
      }
      if (s.gen !== gen) return;
      s.record = cur.record;
      s.version = cur.version;
      s.keys = keys;
      s.lockCause = null;
      s.status = 'ready';
      s.reason = '';
      noteSeen();
      // MASTER-KEY ROTATION: wraps / the provider credential / the signature made with a retired builtin key
      // are redone under the current one now (verified + conditional, like every change). A lost race is fine.
      const stale = provider.isCurrent ? cur.record.dataKeys.filter((k) => !provider.isCurrent!(k.wrapped, k.id)) : [];
      if (stale.length || !credCurrent || integrity === 'previous') {
        const dataKeys: WrappedDataKey[] = [];
        for (const k of cur.record.dataKeys) dataKeys.push(stale.includes(k) ? { ...k, wrapped: await provider.wrap(keys.get(k.id)!, k.id) } : k);
        const pv = cur.record.provider;
        const providerNext = pv.credential && !credCurrent ? { ...pv, credential: sealProviderCredential(d.env, pv.id, openProviderCredential(d.env, pv.id, pv.credential)) } : pv;
        await commit(withHistory({ ...cur.record, provider: providerNext, dataKeys }, 'system', 'rotate.master-key', `re-done under the new builtin master key: ${stale.length} data-key wrap(s)${credCurrent ? '' : ', the provider credential'}, the record signature`), cur.version, keys, provider)
          .catch((e) => console.error(`[keys] re-wrap under the new master key failed (retried next boot): ${e instanceof Error ? e.message : String(e)}`));
      }
    } catch (e) {
      s.status = 'failed';
      s.reason = e instanceof Error ? e.message : String(e);
      console.error(`[keys] key record unavailable: ${s.reason}`);
    } finally {
      publish();
    }
  })().finally(() => {
    st().loading = null;
  });
  return s.loading;
}

/** The keyring the credential store seals/opens with, or null while not ready (locked / failed). */
export function currentKeyring(): Keyring | null {
  const s = st();
  if (s.status !== 'ready' || !s.record) return null;
  const derived = s.record.dataKeys.map((k) => s.keys.get(k.id)).filter((b): b is Buffer => !!b).map((b) => deriveSecretKey(b.toString('base64')));
  if (!derived.length) return null;
  return { current: derived[0], previous: [...derived.slice(1), ...deps().legacy], ephemeral: false };
}

export function keyManagerStatus(): KeyStatus {
  return st().status;
}

export type KeyView = {
  status: KeyStatus;
  reason: string;
  provider: { id: KeyProviderId | null; label: string; config: Record<string, string>; hasCredential: boolean };
  recovery: { state: RecoveryState; pending: boolean; createdAt?: string; createdBy?: string; confirmedAt?: string; confirmedBy?: string };
  /** The admin's recovery choice; `at`/`by` say who made it and when (absent while `unset`). */
  recoveryChoice: { choice: RecoveryChoice; at?: string; by?: string };
  /** Can "Start over with new keys" be offered? (the seen-marker check runs at the time of the request) */
  startOver: { eligible: boolean; reason: string; recoveryPresent: boolean };
  /** Records set aside by earlier start-overs (count only). */
  archived: number;
  dataKeys: { id: string; createdAt: string; current: boolean; recoverable: boolean }[];
  lastHealth: (ProviderHealth & { at: string }) | null;
  history: KeyRecord['history'];
};

function choiceView(r: KeyRecord | null): KeyView['recoveryChoice'] {
  const choice = recoveryChoiceOf(r);
  if (choice === 'none') return { choice, at: r?.recoveryChoice?.at, by: r?.recoveryChoice?.by };
  if (choice === 'recovery-key') return { choice, at: r?.recoveryChoice?.at ?? r?.recovery?.confirmedAt, by: r?.recoveryChoice?.by ?? r?.recovery?.confirmedBy };
  return { choice };
}

/** Everything the admin console shows — ids, dates, states. Never key material or a credential. */
export function keyView(): KeyView {
  const s = st();
  const r = s.record;
  return {
    status: s.status,
    reason: s.reason,
    provider: { id: r?.provider.id ?? null, label: providerInfo(r?.provider.id ?? '')?.label ?? '', config: { ...(r?.provider.config ?? {}) }, hasCredential: Boolean(r?.provider.credential) },
    recovery: { state: recoveryState(r), pending: Boolean(r?.pendingRecovery), createdAt: r?.recovery?.createdAt, createdBy: r?.recovery?.createdBy, confirmedAt: r?.recovery?.confirmedAt, confirmedBy: r?.recovery?.confirmedBy },
    recoveryChoice: choiceView(r),
    startOver: startOverEligibility(),
    archived: r?.archive?.length ?? 0,
    dataKeys: (r?.dataKeys ?? []).map((k, i) => ({ id: k.id, createdAt: k.createdAt, current: i === 0, recoverable: Boolean(k.recovery) })),
    lastHealth: s.lastHealth,
    history: [...(r?.history ?? [])].reverse().slice(0, 20),
  };
}

/** A real round trip against the active provider; remembered for the view and the health warning. */
export async function checkProviderHealth(): Promise<ProviderHealth> {
  const s = st();
  if (!s.record) await loadKeys();
  let h: ProviderHealth;
  try {
    h = s.record ? await providerFor(s.record).health() : { ok: false, state: 'misconfigured', detail: s.reason || 'no key record' };
  } catch (e) {
    h = { ok: false, state: 'misconfigured', detail: e instanceof Error ? e.message : String(e) };
  }
  s.lastHealth = { ...h, at: now() };
  publish();
  return h;
}

// ------------------------------------------------------------------------ changes --

function requireReady(): { record: KeyRecord; version: string } {
  const s = st();
  if (s.status !== 'ready' || !s.record || s.version === null) throw new KeyOperationError(409, s.status === 'locked' ? 'the stored credentials are locked — unlock them first (recovery key or provider credential)' : `key management is not ready (${s.status}${s.reason ? `: ${s.reason}` : ''})`);
  return { record: s.record, version: s.version };
}

function withHistory(r: KeyRecord, actor: string, action: string, detail: string): KeyRecord {
  return { ...r, updatedAt: now(), history: [...r.history, { at: now(), actor, action, detail }].slice(-HISTORY_MAX) };
}

/** Verify every wrap in `next` opens to the data key we hold, then write it conditionally and adopt it. */
async function commit(next: KeyRecord, expected: string, keys: Map<string, Buffer>, provider: KeyProvider): Promise<void> {
  for (const k of next.dataKeys) {
    const want = keys.get(k.id);
    if (!want) throw new KeyOperationError(500, `verification: data key ${k.id} is not in memory`);
    const back = await provider.unwrap(k.wrapped, k.id).catch((e) => {
      throw new KeyOperationError(502, `verification failed — the new wrap of ${k.id} does not open (${e instanceof Error ? e.message : String(e)}); nothing was changed`);
    });
    if (!back.equals(want)) throw new KeyOperationError(502, `verification failed — the new wrap of ${k.id} opens to another key; nothing was changed`);
    if (next.recovery && k.recovery === undefined) throw new KeyOperationError(500, `verification: data key ${k.id} has no recovery wrap`);
  }
  const s = st();
  const record = signed(next);
  try {
    const { version } = await deps().store.write(record, expected);
    s.gen++;
    s.record = record;
    s.version = version;
    s.keys = keys;
    s.lockCause = null;
    s.status = 'ready';
    s.reason = '';
    noteSeen();
  } catch (e) {
    if (e instanceof SecretConflictError) throw new KeyOperationError(409, 'the key record changed meanwhile (another admin or pod) — reload and try again; nothing was changed');
    throw new KeyOperationError(503, `the key record could not be written (${e instanceof Error ? e.message : String(e)}); nothing was changed`);
  } finally {
    publish();
  }
}

/**
 * Generate a NEW recovery key. Returned ONCE; only its verifier is stored — as PENDING. A recovery key
 * already saved keeps working until the person confirms the new one ("I saved it").
 */
export async function generateRecoveryKey(actor: string): Promise<{ recoveryKey: string }> {
  const { record, version } = requireReady();
  const recoveryKey = newRecoveryKey();
  const v = recoveryVerifier(recoveryKey);
  const rid = randomBytes(4).toString('hex');
  // Prove the verifier and a wrap round-trip before anything is stored.
  const probe = randomBytes(32);
  if (!unwrapWithRecovery(v, recoveryKey, wrapForRecovery(v, probe, 'probe'), 'probe').equals(probe)) throw new KeyOperationError(500, 'recovery key self-test failed; nothing was changed');
  const next = withHistory({ ...record, pendingRecovery: { id: rid, salt: v.salt, publicKey: v.publicKey, createdAt: now(), createdBy: actor } }, actor, 'recovery.generate', `recovery key ${rid} generated (pending until confirmed${record.recovery ? `; ${record.recovery.id} stays valid until then` : ''})`);
  await commit(next, version, st().keys, providerFor(record));
  return { recoveryKey };
}

/**
 * "I saved it": the pending recovery key becomes THE recovery key; every data key is wrapped to it.
 * The person TYPES THE KEY BACK — so the confirmation is bound to the key they actually saw (two tabs
 * that each generated one cannot confirm the other's), and to one they really wrote down.
 */
export async function confirmRecoveryKey(actor: string, typed: string): Promise<void> {
  const { record, version } = requireReady();
  const p = record.pendingRecovery;
  if (!p) throw new KeyOperationError(409, 'no recovery key to confirm — generate one first');
  if (!recoveryKeyMatches(p, typed)) throw new KeyOperationError(400, 'that is not the recovery key waiting for confirmation — type the key you saved (a newer one may have been generated in another tab)');
  const s = st();
  // Confirming a recovery key IS the "Recovery key" choice — DERIVED from the signed confirmed state, never
  // written as a field: an earlier "none" is removed, so the record is exactly what an os-ui from before the
  // recovery choice signs and verifies (a rollback stays safe for the recovery-key flow).
  const { pendingRecovery: _p, recoveryChoice: _c, ...rest } = record;
  void _p;
  void _c;
  const next = withHistory({
    ...rest,
    recovery: { ...p, confirmedAt: now(), confirmedBy: actor },
    dataKeys: record.dataKeys.map((k) => ({ ...k, recovery: wrapForRecovery(p, s.keys.get(k.id)!, k.id) })),
  }, actor, 'recovery.confirm', `recovery key ${p.id} confirmed as saved${record.recovery ? ` (replaces ${record.recovery.id})` : ''}`);
  await commit(next, version, s.keys, providerFor(record));
}

/**
 * Test restore WITHOUT restoring: does this recovery key open every data key, and does the active
 * provider open them? Writes nothing (no history entry either — the route audits it).
 */
export async function testRestore(typed?: string): Promise<{ recovery: 'ok' | 'wrong-key' | 'no-recovery' | 'skipped'; provider: 'ok' | 'failed'; detail: string }> {
  const s = st();
  if (!s.record) await loadKeys();
  const r = s.record;
  if (!r) throw new KeyOperationError(503, s.reason || 'no key record');
  let recovery: 'ok' | 'wrong-key' | 'no-recovery' | 'skipped' = 'skipped';
  const notes: string[] = [];
  if (typed !== undefined && typed !== '') {
    if (!r.recovery) recovery = 'no-recovery';
    else if (!recoveryKeyMatches(r.recovery, typed)) recovery = 'wrong-key';
    else {
      try {
        for (const k of r.dataKeys) {
          if (!k.recovery) throw new Error(`data key ${k.id} has no recovery wrap`);
          const dek = unwrapWithRecovery(r.recovery, typed, k.recovery, k.id);
          if (idOf(dek) !== k.id) throw new Error(`data key ${k.id} opens to another key`);
        }
        recovery = 'ok';
      } catch (e) {
        recovery = 'wrong-key';
        notes.push(e instanceof Error ? e.message : String(e));
      }
    }
  }
  let provider: 'ok' | 'failed' = 'ok';
  try {
    await unwrapAll(r, providerFor(r));
  } catch (e) {
    provider = 'failed';
    notes.push(`provider: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { recovery, provider, detail: notes.join('; ') };
}

/** Provider errors leave this module as KeyOperationError (a named 4xx/502), never a raw 500. */
function asOpError(e: unknown, what: string): KeyOperationError {
  if (e instanceof KeyOperationError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  const status = e instanceof KeyProviderError ? (e.code === 'unreachable' ? 502 : e.code === 'not-available' || e.code === 'misconfigured' ? 400 : 409) : 500;
  return new KeyOperationError(status, `${what}: ${msg}; nothing was changed`);
}

/** Validate a provider choice (id + config + credential) into the record's provider entry + a live provider. */
function buildTarget(id: string, config: Record<string, string>, credential: string | undefined, record: KeyRecord): { entry: KeyRecord['provider']; provider: KeyProvider } {
  const info = providerInfo(id);
  if (!info) throw new KeyOperationError(400, `unknown key provider '${id}'`);
  if (!info.available) throw new KeyOperationError(400, `${info.label} is not yet available`);
  const d = deps();
  const cfg: Record<string, string> = {};
  for (const f of info.config) {
    const val = String(config?.[f.name] ?? '').trim();
    if (f.required && !val) throw new KeyOperationError(400, `${f.label} is required`);
    if (val) cfg[f.name] = val;
  }
  const sameConfig = record.provider.id === id && JSON.stringify(Object.entries(cfg).sort()) === JSON.stringify(Object.entries(record.provider.config ?? {}).sort());
  // The stored credential is reused only for the SAME configuration: a changed endpoint/key must not
  // receive a token the console never shows.
  if (info.credential?.required && !credential && !(sameConfig && record.provider.credential)) throw new KeyOperationError(400, `${info.credential.label} is required${record.provider.id === id ? ' when the configuration changes' : ''}`);
  const sealed = credential ? sealProviderCredential(d.env, id, credential) : sameConfig ? record.provider.credential : undefined;
  let opened = credential;
  if (!opened && sealed) {
    try {
      opened = openProviderCredential(d.env, id, sealed);
    } catch (e) {
      throw asOpError(e, `the stored ${info.label} credential cannot be opened — enter it again`);
    }
  }
  return { entry: { id: id as KeyProviderId, config: cfg, ...(sealed ? { credential: sealed } : {}) }, provider: createKeyProvider(id, cfg, opened, { env: d.env, kms: d.kms }) };
}

/**
 * UNLOCK after a restore (or when the active provider is lost): the recovery key opens every data key;
 * each is re-wrapped under a provider that WORKS NOW (verified) and the record is written.
 *   - `target` given: that provider (the admin picks it — e.g. a new STACKIT key, or builtin).
 *   - otherwise the active provider if it passes a real round trip; if it does not (KMS key deleted,
 *     token revoked, credential sealed under a master key the rebuilt cluster no longer has), the
 *     data keys move to `builtin` — the one provider that always exists — and the history says so.
 */
export async function restoreWithRecoveryKey(typed: string, actor: string, target?: { provider: string; config?: Record<string, string>; credential?: string }): Promise<{ provider: KeyProviderId; fellBackFrom?: KeyProviderId }> {
  const s = st();
  if (!s.record || s.version === null) await loadKeys();
  const r = s.record;
  const version = s.version;
  if (!r || version === null) throw new KeyOperationError(503, s.reason || 'no key record');
  if (!r.recovery) throw new KeyOperationError(409, 'this installation has no recovery key — it cannot be unlocked with one');
  if (!recoveryKeyMatches(r.recovery, typed)) throw new KeyOperationError(400, 'the recovery key does not match');
  const keys = new Map<string, Buffer>();
  for (const k of r.dataKeys) {
    if (!k.recovery) throw new KeyOperationError(409, `data key ${k.id} was created without a recovery wrap — it cannot be recovered`);
    let dek: Buffer;
    try {
      dek = unwrapWithRecovery(r.recovery, typed, k.recovery, k.id);
    } catch (e) {
      throw asOpError(e, `data key ${k.id} does not open with the recovery key`);
    }
    if (idOf(dek) !== k.id) throw new KeyOperationError(409, `data key ${k.id}: the recovery wrap opens to another key (altered record?); nothing was changed`);
    keys.set(k.id, dek);
  }
  let entry: KeyRecord['provider'];
  let provider: KeyProvider;
  let fellBackFrom: KeyProviderId | undefined;
  if (target) {
    ({ entry, provider } = buildTarget(target.provider, target.config ?? {}, target.credential, r));
    const h = await provider.health();
    if (!h.ok) throw new KeyOperationError(400, `${providerInfo(target.provider)?.label ?? target.provider} is not usable: ${h.detail}; nothing was changed`);
  } else {
    // Fall back to builtin only on a LASTING failure (refused token, deleted/misconfigured key, a
    // credential this cluster cannot open). A KMS that is merely unreachable right now must not
    // downgrade the installation: refuse, and let the admin retry or pick a provider explicitly.
    let usable = false;
    try {
      provider = providerFor(r);
      const h = await provider.health();
      if (h.state === 'unreachable') throw new KeyOperationError(503, `${providerInfo(r.provider.id)?.label ?? r.provider.id} is unreachable (${h.detail}) — retry, or pick a provider explicitly; nothing was changed`);
      usable = h.ok;
      if (!usable) console.error(`[keys] restore: the ${r.provider.id} provider cannot be used (${h.state}): ${h.detail}`);
    } catch (e) {
      if (e instanceof KeyOperationError) throw e;
      console.error(`[keys] restore: the ${r.provider.id} provider cannot be used: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (usable) entry = r.provider;
    else {
      fellBackFrom = r.provider.id;
      ({ entry, provider } = buildTarget('builtin', {}, undefined, r));
    }
  }
  const dataKeys: WrappedDataKey[] = [];
  try {
    for (const k of r.dataKeys) dataKeys.push({ ...k, wrapped: await provider!.wrap(keys.get(k.id)!, k.id), provider: entry.id });
  } catch (e) {
    throw asOpError(e, `wrapping under ${entry.id} failed`);
  }
  const detail = `data keys re-wrapped under ${entry.id} with recovery key ${r.recovery.id}${fellBackFrom ? ` (${fellBackFrom} could not be used — moved to builtin; switch back once it works)` : entry.id !== r.provider.id ? ` (provider ${r.provider.id} → ${entry.id})` : ''}`;
  await commit(withHistory({ ...r, provider: entry, dataKeys }, actor, 'restore.recovery-key', detail), version, keys, provider!);
  return { provider: entry.id, ...(fellBackFrom ? { fellBackFrom } : {}) };
}

/** Replace the provider credential (an expired KMS token; a restored cluster whose builtin key changed). Verified by unwrapping. */
export async function updateProviderCredential(credential: string, actor: string): Promise<void> {
  const s = st();
  if (!s.record || s.version === null) await loadKeys();
  const r = s.record;
  const version = s.version;
  if (!r || version === null) throw new KeyOperationError(503, s.reason || 'no key record');
  if (!providerInfo(r.provider.id)?.credential) throw new KeyOperationError(400, `the ${r.provider.id} provider takes no credential`);
  let sealed: string;
  try {
    sealed = sealProviderCredential(deps().env, r.provider.id, credential);
  } catch (e) {
    throw asOpError(e, 'the credential could not be sealed');
  }
  // A record whose signature cannot be checked (new builtin key after a restore, or altered) is re-signed
  // here — but NOT its recovery verifiers: they cannot be proven genuine, so a new recovery key is required.
  const trusted = macState(r) !== 'invalid';
  const base: KeyRecord = trusted ? r : dropRecovery(r);
  const next = withHistory({ ...base, provider: { ...r.provider, credential: sealed } }, actor, 'provider.credential', `credential of ${r.provider.id} replaced${trusted ? '' : '; the recovery key was dropped (its verifier could not be authenticated) — generate a new one'}`);
  let provider: KeyProvider;
  try {
    provider = providerFor(next);
  } catch (e) {
    throw asOpError(e, 'the provider cannot be built');
  }
  const keys = await unwrapAll(next, provider).catch((e) => {
    throw new KeyOperationError(400, `the new credential does not open the data keys: ${e instanceof Error ? e.message : String(e)}; nothing was changed`);
  });
  await commit(next, version, keys, provider);
}

/** Remove every recovery verifier, every recovery wrap and the recovery choice (an unauthenticated record's
 *  choice cannot be trusted either — the admin chooses again). */
function dropRecovery(r: KeyRecord): KeyRecord {
  const { recovery: _r, pendingRecovery: _p, recoveryChoice: _c, ...x } = r;
  void _r;
  void _p;
  void _c;
  return { ...x, dataKeys: x.dataKeys.map(({ recovery: _w, ...k }) => { void _w; return k; }) };
}

/**
 * RECOVERY CHOICE "No recovery key": the admin acknowledged that if the master key is lost, the stored
 * credentials cannot be decrypted and every connection must be reconnected. Signed into the record with
 * who and when. Any recovery verifier, pending key and recovery wrap is REMOVED from the record — a copy
 * exported earlier no longer opens the live record, but it still opens backups taken before this change
 * and the data keys they hold, until a NEW data key is minted (Rotate → New data key) and the old one is
 * retired. `hadRecoveryKey` tells the caller to say so.
 */
export async function chooseNoRecoveryKey(actor: string): Promise<{ hadRecoveryKey: boolean }> {
  const { record, version } = requireReady();
  const hadRecoveryKey = Boolean(record.recovery);
  const s = st();
  const base = dropRecovery(record);
  const next = withHistory({ ...base, recoveryChoice: { mode: 'none', at: now(), by: actor } }, actor, 'recovery.none',
    `recovery choice: no recovery key (acknowledged — a lost master key means reconnecting the connections)${hadRecoveryKey ? `; recovery key ${record.recovery!.id} removed from the key record (copies exported earlier still open older backups until a new data key replaces the current one)` : ''}`);
  await commit(next, version, s.keys, providerFor(record));
  return { hadRecoveryKey };
}

/**
 * START OVER after the master key is LOST and nothing can unlock the record (no recovery key, or it is
 * lost too), on an admin's explicit acknowledgement (the route enforces it). Guards, in order (see the
 * header, "START-OVER GUARDS"): a fresh re-read; the snapshot is locked with cause `key-mismatch` on a
 * `builtin` record (`startOverEligibility`); a recovery key in the record needs `overrideRecovery`; no
 * other process opened this very record within SEEN_FRESH_MS. Then a NEW key record (new data key,
 * provider builtin — or eso when OS_KEY_PROVIDER says so) replaces the locked one, conditional on the
 * snapshot's version, with the previous record ARCHIVED inside it (still wrapped) and its history marked
 * unverified. Values sealed under the old data keys become unreadable (`unknown-key`, never guessed) and
 * their connections read `needs-reconnect`. The recovery choice is NOT carried over (the old record could
 * not be authenticated): the admin chooses again.
 */
/** Can a start-over be offered for the record as this process last read it? (sync; the UI shows the card
 *  only when eligible — `resetLockedKeys` re-reads and checks again, plus the seen markers). */
export function startOverEligibility(): { eligible: boolean; reason: string; recoveryPresent: boolean } {
  const s = st();
  const recoveryPresent = Boolean(s.record?.recovery || s.record?.pendingRecovery);
  const no = (reason: string) => ({ eligible: false, reason, recoveryPresent });
  if (s.status !== 'locked' || !s.record) return no('the stored credentials are not locked');
  if (s.record.provider.id !== 'builtin') return no(`the ${s.record.provider.id} key provider still holds the master key — re-enter its credential, fix its configuration, or unlock with the recovery key`);
  if (s.lockCause === 'tampered') return no('this process\'s master key still opens the data keys, but the key record was altered — restore os-conn-keyring from a backup (or unlock with the recovery key)');
  if (s.lockCause !== 'key-mismatch') return no('the lock is not caused by a lost master key');
  return { eligible: true, reason: 'no configured master key verifies or opens the key record', recoveryPresent };
}

export async function resetLockedKeys(actor: string, opts: { overrideRecovery?: boolean } = {}): Promise<{ currentKeyId: string; archived: number; recoveryOverridden: boolean }> {
  // Fresh read: never decide on this process's possibly stale view (another pod may have unlocked or rotated).
  await loadKeys();
  const s = st();
  // Capture the record, its version and the lock cause TOGETHER — everything below works on this snapshot.
  const snap = { record: s.record, version: s.version, cause: s.lockCause };
  const elig = startOverEligibility();
  if (!elig.eligible || !snap.record || snap.version === null) throw new KeyOperationError(409, `starting over is not possible: ${elig.reason}`);
  const old = snap.record;
  const recoveryPresent = elig.recoveryPresent;
  if (recoveryPresent && opts.overrideRecovery !== true) {
    throw new KeyOperationError(409, 'the key record holds a recovery key — unlock with it instead; start over without it only with the explicit recovery override');
  }
  // Is the record healthy for ANOTHER process? Then this process has the wrong master key.
  const store = deps().store;
  if (!store.seen) throw new KeyOperationError(409, 'starting over is not possible: this installation cannot confirm that no other process can open the key record');
  let seen;
  try {
    seen = await store.seen.list();
  } catch (e) {
    throw new KeyOperationError(503, `starting over is not possible: the seen markers cannot be read (${e instanceof Error ? e.message : String(e)}); nothing was changed`);
  }
  const me = deps().processId;
  const clockMs = deps().now();
  const fresher = seen.filter((e) => e.process !== me && e.mac === old.mac && clockMs - Date.parse(e.at) < SEEN_FRESH_MS);
  if (fresher.length) {
    throw new KeyOperationError(409, `starting over is not possible: another OS process opened this key record ${Math.max(0, Math.round((clockMs - Date.parse(fresher[0].at)) / 60_000))} min ago, so the record is healthy and this process's master key is out of date — restart this process (or fix its OS_SECRETS_ENCRYPTION_KEY); nothing was changed`);
  }
  let fresh: KeyRecord;
  try {
    fresh = await initialRecord();
  } catch (e) {
    throw asOpError(e, 'a new data key could not be created');
  }
  // ARCHIVE the previous record (still wrapped) instead of discarding it.
  const archivedEntry = {
    archivedAt: now(),
    archivedBy: actor,
    reason: 'start over after the master key was lost',
    provider: old.provider,
    dataKeys: old.dataKeys,
    ...(old.recovery ? { recovery: old.recovery } : {}),
    ...(old.pendingRecovery ? { pendingRecovery: old.pendingRecovery } : {}),
    ...(old.recoveryChoice ? { recoveryChoice: old.recoveryChoice } : {}),
    ...(old.mac ? { mac: old.mac } : {}),
  };
  // Keep the ORIGINAL archived record (the oldest — the one most likely to hold real credentials) plus the
  // last two; never evict the original.
  const allArchived = [...(old.archive ?? []), archivedEntry];
  const archive = allArchived.length <= 3 ? allArchived : [allArchived[0], ...allArchived.slice(-2)];
  // History carried over from a record that failed verification is marked unverified (it is informational
  // and never signed, so nothing is decided from it).
  const carried = old.history.map((h) => ({ ...h, unverified: true }));
  const next = signed(withHistory({ ...fresh, archive, history: [...carried, ...fresh.history].slice(-HISTORY_MAX) }, actor, 'reset.lost-key',
    `started over with new data key ${fresh.dataKeys[0].id} (no configured master key opens the previous record; ${old.dataKeys.length} old data key(s) archived, still wrapped — their connections must be reconnected)${recoveryPresent ? '; the recovery key in the previous record was overridden' : ''}`));
  try {
    await store.write(next, snap.version);
  } catch (e) {
    if (e instanceof SecretConflictError) throw new KeyOperationError(409, 'the key record changed meanwhile (another admin or pod) — reload and try again; nothing was changed');
    throw new KeyOperationError(503, `the key record could not be written (${e instanceof Error ? e.message : String(e)}); nothing was changed`);
  }
  s.gen++;
  s.version = null;
  s.status = 'unavailable';
  await loadKeys();
  // A load already in flight may have read the locked record before the write: load once more.
  if (st().status !== 'ready') await loadKeys();
  if (st().status !== 'ready') throw new KeyOperationError(500, `the new key record does not load (${st().reason})`);
  return { currentKeyId: fresh.dataKeys[0].id, archived: archive.length, recoveryOverridden: recoveryPresent };
}

/**
 * ROTATE. `newDataKey: false` re-wraps every data key under the provider (e.g. a new KMS key version
 * in the config). `newDataKey: true` also mints a new current data key; the store re-seals every
 * credential under it in the background (each refresh), and the old key stays decrypt-only.
 */
export async function rotateKeys(opts: { newDataKey: boolean }, actor: string): Promise<{ currentKeyId: string }> {
  const { record, version } = requireReady();
  const s = st();
  const keys = new Map(s.keys);
  const v = record.recovery;
  let dataKeys: WrappedDataKey[] = [];
  let provider: KeyProvider;
  try {
    provider = providerFor(record);
    for (const k of record.dataKeys) dataKeys.push({ ...k, wrapped: await provider.wrap(keys.get(k.id)!, k.id), provider: record.provider.id });
    if (opts.newDataKey) {
      const dek = randomBytes(32);
      const id = idOf(dek);
      keys.set(id, dek);
      dataKeys = [{ id, wrapped: await provider.wrap(dek, id), provider: record.provider.id, createdAt: now(), ...(v ? { recovery: wrapForRecovery(v, dek, id) } : {}) }, ...dataKeys];
    }
  } catch (e) {
    throw asOpError(e, `the ${record.provider.id} provider could not wrap the data key`);
  }
  await commit(withHistory({ ...record, dataKeys }, actor, opts.newDataKey ? 'rotate.data-key' : 'rotate.rewrap', opts.newDataKey ? `new data key ${dataKeys[0].id}; credentials re-seal in the background` : `data keys re-wrapped under ${record.provider.id}`), version, keys, provider);
  return { currentKeyId: dataKeys[0].id };
}

/**
 * SWITCH PROVIDER: health-check the new provider, re-wrap every data key under it, unwrap each wrap
 * again to verify, and only then commit. A failure anywhere leaves the old provider in charge.
 */
export async function switchProvider(id: string, config: Record<string, string>, credential: string | undefined, actor: string): Promise<{ health: ProviderHealth }> {
  const { record, version } = requireReady();
  const { entry, provider } = buildTarget(id, config, credential, record);
  const health = await provider.health();
  if (!health.ok) throw new KeyOperationError(400, `the new provider is not usable: ${health.detail}; nothing was changed`);
  const s = st();
  const dataKeys: WrappedDataKey[] = [];
  try {
    for (const k of record.dataKeys) dataKeys.push({ ...k, wrapped: await provider.wrap(s.keys.get(k.id)!, k.id), provider: entry.id });
  } catch (e) {
    throw asOpError(e, `wrapping under ${id} failed`);
  }
  await commit(withHistory({ ...record, provider: entry, dataKeys }, actor, 'provider.switch', `${record.provider.id} → ${id}; ${dataKeys.length} data key(s) re-wrapped and verified`), version, new Map(s.keys), provider);
  st().lastHealth = { ...health, at: now() };
  publish();
  return { health };
}

/**
 * Drop RETIRED data keys no stored credential is sealed under any more (the store calls this after a
 * complete re-seal). The current key is never dropped. Conditional like every change; a lost race or an
 * unready manager is simply skipped (next pass).
 */
export async function pruneRetiredDataKeys(inUse: Set<string>, nowMs = Date.now()): Promise<number> {
  const s = st();
  if (s.status !== 'ready' || !s.record || s.version === null || s.record.dataKeys.length < 2) return 0;
  // GRACE PERIOD: a retired key stays for OS_KEY_RETIRED_GRACE_DAYS (default 7) after the key that
  // replaced it was created. A pod still holding the OLD keyring (the worker reloads the record every
  // refresh, ≤ 15 s — but a pod whose record reads keep failing keeps the keys it has) can still write
  // under it; those values must stay readable until it caught up. A key is "retired at" the createdAt
  // of the key listed before it (the one that became current over it).
  const days = Number(deps().env[KEY_GRACE_ENV] ?? '');
  const graceMs = (Number.isFinite(days) && days >= 0 && deps().env[KEY_GRACE_ENV] ? days : 7) * 86_400_000;
  const list = s.record.dataKeys;
  const keep = list.filter((k, i) => i === 0 || inUse.has(k.id) || nowMs - Date.parse(list[i - 1].createdAt) < graceMs);
  const dropped = s.record.dataKeys.length - keep.length;
  if (!dropped) return 0;
  const keys = new Map([...s.keys].filter(([id]) => keep.some((k) => k.id === id)));
  try {
    await commit(withHistory({ ...s.record, dataKeys: keep }, 'system', 'rotate.prune', `${dropped} retired data key(s) removed — past the ${graceMs / 86_400_000}-day grace and no stored credential uses them`), s.version, keys, providerFor(s.record));
  } catch (e) {
    console.error(`[keys] pruning retired data keys skipped (next pass retries): ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
  return dropped;
}

/** Test a provider configuration WITHOUT switching (install wizard / console "Test connection"). */
export async function testProviderConfig(id: string, config: Record<string, string>, credential: string | undefined): Promise<ProviderHealth> {
  const info = providerInfo(id);
  if (!info) return { ok: false, state: 'misconfigured', detail: `unknown key provider '${id}'` };
  if (!info.available) return { ok: false, state: 'not-available', detail: `${info.label} is not yet available` };
  const d = deps();
  try {
    return await createKeyProvider(id, config ?? {}, credential, { env: d.env, kms: d.kms }).health();
  } catch (e) {
    return { ok: false, state: 'misconfigured', detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The non-secret summary /api/health exposes for the release smoke test — computed from the record
 * this process VERIFIED (MAC), never from a raw annotation. `recovery` is `confirmed` only when the
 * signed record says so.
 */
export function keyHealthSummary(): { status: KeyStatus; provider: KeyProviderId | null; recovery: RecoveryState; recoveryChoice: RecoveryChoice; seenMarker: 'ok' | 'failing' } {
  const s = st();
  const trusted = s.status === 'ready';
  return {
    status: s.status,
    provider: trusted ? s.record?.provider.id ?? null : null,
    recovery: trusted ? recoveryState(s.record) : 'missing',
    recoveryChoice: trusted ? recoveryChoiceOf(s.record) : 'unset',
    seenMarker: s.seenError ? 'failing' : 'ok',
  };
}

/** Monitoring → Platform alerts for the key setup (empty when all is well). */
export function connectionKeyAlerts(): { id: string; severity: 'critical' | 'warning'; title: string; detail: string }[] {
  const s = st();
  const out: { id: string; severity: 'critical' | 'warning'; title: string; detail: string }[] = [];
  if (s.status === 'locked') out.push({ id: 'connection-keys-locked', severity: 'critical', title: 'Stored connection credentials are locked', detail: `The ${s.record?.provider.id} key provider cannot unwrap the data key (${s.reason}). Unlock under Platform → Encryption keys with the recovery key or the provider credential.` });
  if (s.status === 'failed') out.push({ id: 'connection-keys-failed', severity: 'critical', title: 'Key management is not working', detail: s.reason });
  if (s.status === 'unavailable') out.push({ id: 'connection-keys-unavailable', severity: 'critical', title: 'Key provider not answering', detail: `${s.reason} — retrying automatically.` });
  if (s.status === 'ready') {
    const rs = recoveryState(s.record);
    if (recoveryChoiceOf(s.record) === 'unset') out.push({ id: 'connection-keys-recovery', severity: 'warning', title: rs === 'unconfirmed' ? 'Recovery key not confirmed as saved' : 'No recovery choice made for connection credentials', detail: 'Choose under Platform → Encryption keys → Recovery: "No recovery key" (if the master key is lost, connections are reconnected) or "Recovery key" (save it offline and confirm).' });
  }
  if (s.lastHealth && !s.lastHealth.ok) out.push({ id: 'connection-keys-provider', severity: 'warning', title: 'Key provider unhealthy', detail: s.lastHealth.detail });
  if (s.seenError) out.push({ id: 'connection-keys-seen-marker', severity: 'warning', title: 'This OS process cannot record that it holds the encryption keys', detail: `Writing its seen marker failed (${s.seenError}). These markers stop a process with an out-of-date master key from starting over over healthy keys; check the conn-secrets namespace Role and the Kubernetes API.` });
  return out;
}
