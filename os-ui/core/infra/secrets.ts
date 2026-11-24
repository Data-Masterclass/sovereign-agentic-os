/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { isHostApproved } from '@tabs/connections/lib/egress-requests';
import { k8s as liveK8s } from '@core/infra/k8s';
import { scheduleEvery } from '@core/reconcile/runtime';
import { clearHealthWarning, setHealthWarning } from '@core/infra/health-warnings';
import {
  kubernetesSecretBackend,
  memorySecretBackend,
  MAX_SECRET_VALUE_BYTES,
  SecretConflictError,
  type SealedRecord,
  type SecretBackend,
} from '@core/infra/secret-backend';
import {
  fingerprintSecret,
  keyringFromEnv,
  openSecret,
  sealSecret,
  sealedKeyId,
  SecretCryptoError,
  type Keyring,
} from '@core/infra/secret-crypto';
import { configureKeyManager, currentKeyring, keyManagerStatus, loadKeys, pruneRetiredDataKeys } from '@core/infra/key-manager';
import { kubernetesKeyStateStore, type KeyStateStore } from '@core/infra/key-state';

/**
 * The connection-credential store (Connections golden path §2, security.md). THE ONE RULE: the
 * secret never leaves the store. A connection RECORD holds only a reference (`{ name, key }`); the
 * raw value is written here, server-side, and NEVER serialized into a record, an API response, a
 * Langfuse trace, or a log line.
 *
 * DURABLE (2026-11-23). This used to be an in-process Map: every os-ui restart lost every stored
 * credential, and the os-ui-worker had its own empty Map. Now:
 *   - Values are SEALED (AES-256-GCM, `secret-crypto.ts`) and kept by a {@link SecretBackend}:
 *     Kubernetes Secrets in a DEDICATED namespace (`OS_SECRETS_NAMESPACE`) on a cluster, a Map in
 *     local dev/tests.
 *   - The public API stays SYNCHRONOUS (~30 callers read a credential inline): reads come from an
 *     in-process cache HYDRATED at boot (`ensureSecretsHydrated`, awaited by instrumentation.ts and the
 *     worker) and REFRESHED from the backend (a timer in both pods; the worker also before an agent tool
 *     reads connections). THE BACKEND IS THE TRUTH: a listed record replaces the cached one whenever its
 *     backend version differs, unless this process has a write for that ref in flight or still to retry.
 *     No wall clocks are compared between pods.
 *   - Writes are WRITE-THROUGH and CONDITIONAL on the version this process last saw (Kubernetes
 *     `resourceVersion`). On a conflict a user's explicit write re-reads and overwrites ('overwrite');
 *     a background OAuth token refresh ADOPTS the other writer's value ('adopt') — two pods refreshing
 *     the same rotating refresh token must not clobber the newer set. A failed write stays cached, is
 *     never dropped by a refresh, is retried on every refresh, and is a health warning until it lands.
 *     `awaitSecretWrites()` lets a caller refuse to report success for a write that did not persist.
 *   - NO SILENT FALLBACK. Backend selection is explicit (`OS_SECRETS_BACKEND=kubernetes|memory`); unset
 *     means `kubernetes` inside a cluster and `memory` only outside one. CONFIGURATION errors (no key,
 *     unknown backend, no namespace) are permanent `failed`. A backend that cannot be READ at boot is
 *     `unavailable`: writes refuse, `/api/status` + `/api/health` say so, and the refresh timer retries
 *     with backoff until it answers — a transient API blip at boot heals itself.
 *   - ROTATION: a value sealed under a previous key is re-sealed under the current key on refresh; the
 *     count still under a previous key is reported.
 *   - Fingerprints are an HMAC under the server key, not an unsalted SHA-256.
 *   - Health messages carry COUNTS only (any signed-in user can read `/api/status`); refs go to the log
 *     and to the admin-only Monitoring → Platform view.
 *   - ENVELOPE ENCRYPTION (2026-11-24, key-manager.ts): on the durable backend values are sealed under
 *     a random DATA KEY that a pluggable KEY PROVIDER wraps (builtin master key + recovery key,
 *     STACKIT KMS, ESO; key-providers.ts). Each pass first (re)loads the key record; a new keyring
 *     (rotation, switch, restore on another pod) forces every value to be re-opened, so values under
 *     a retired data key — or under the pre-envelope env key — are re-sealed under the current one.
 *     A key record the provider cannot unwrap makes the store `locked`: nothing is served or saved
 *     until an admin unlocks it (recovery key / provider credential). Never a silent new key.
 */

export type SecretRef = { name: string; key: string };

export class SecretStoreUnavailableError extends Error {
  readonly status = 503;
  constructor(message: string) {
    super(message);
    this.name = 'SecretStoreUnavailableError';
  }
}

export const SECRETS_BACKEND_ENV = 'OS_SECRETS_BACKEND';
export const SECRETS_NAMESPACE_ENV = 'OS_SECRETS_NAMESPACE';
/** Health-warning name the store raises while it cannot do its job. */
export const SECRETS_HEALTH = 'connection-secrets';
/** Background refresh period (both pods) and the worker's max staleness before a read. */
export const SECRETS_REFRESH_MS = 15_000;
export const SECRETS_WORKER_MAX_AGE_MS = 5_000;
/** Backoff for re-trying a boot hydration the backend did not answer. */
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 300_000;

/** How a write resolves a conflict: re-read and overwrite (a user's explicit save), or take the other writer's value. */
export type ConflictPolicy = 'overwrite' | 'adopt';

type Entry = { value: string; version: string | null };
type StoreStatus = 'unconfigured' | 'hydrating' | 'unavailable' | 'locked' | 'ready' | 'failed';
type Retry = { value: string; policy: ConflictPolicy; error: string };
type State = {
  backend: SecretBackend | null;
  ring: Keyring | null;
  /** Data keys come from the key manager (envelope encryption) instead of the env keyring. */
  envelope: boolean;
  /** Envelope mode: the env-derived keyring — decrypts pre-envelope values, and keys the FINGERPRINTS so
   *  they stay comparable across data-key rotations. */
  legacyRing: Keyring | null;
  /** Refs to re-open (and re-seal if needed) at the next listing after a keyring change — without
   *  forgetting their backend version (a write in between must stay conditional on it). */
  reopen: Set<string>;
  status: StoreStatus;
  reason: string;
  cache: Map<string, Entry>;
  /** In-flight writes/deletes by ref — a listing never overrides a ref with one pending. */
  pending: Map<string, Promise<void>>;
  /** Refs whose durable write failed: the value lives only here; retried on every refresh, never dropped. */
  failedWrites: Map<string, Retry>;
  /** Refs deleted here whose backend delete has not succeeded yet — a listing must not bring them back. */
  tombstones: Map<string, string>;
  /** Refs present in the backend that this pod cannot decrypt (other key, tampered). */
  unreadable: Map<string, string>;
  /** Refs whose stored value is sealed under a previous key (re-sealed on refresh). */
  previousKey: Set<string>;
  /** Per ref: the sequence number of this process's last completed write/delete — a listing that started
   *  before it (lower `seq`) is stale for that ref. A counter, not a clock (two events can share a ms). */
  localWriteAt: Map<string, number>;
  seq: number;
  conflictsAdopted: number;
  hydrating: Promise<void> | null;
  refreshing: Promise<void> | null;
  refreshedAt: number;
  retryDelay: number;
  nextAttemptAt: number;
  stopTimer: (() => void) | null;
};

const STATE_KEY = Symbol.for('soa.secrets.store');
function st(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  if (!g[STATE_KEY]) {
    g[STATE_KEY] = {
      backend: null, ring: null, envelope: false, legacyRing: null, reopen: new Set(), status: 'unconfigured', reason: '', cache: new Map(), pending: new Map(),
      failedWrites: new Map(), tombstones: new Map(), unreadable: new Map(), previousKey: new Set(), localWriteAt: new Map(), seq: 0,
      conflictsAdopted: 0, hydrating: null, refreshing: null, refreshedAt: 0, retryDelay: RETRY_MIN_MS, nextAttemptAt: 0, stopTimer: null,
    };
  }
  return g[STATE_KEY]!;
}

function refKey(ref: SecretRef): string {
  return `${ref.name}/${ref.key}`;
}
function splitKey(k: string): SecretRef {
  const i = k.lastIndexOf('/');
  return { name: k.slice(0, i), key: k.slice(i + 1) };
}

function inCluster(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.KUBERNETES_SERVICE_HOST);
}

/** A permanent CONFIGURATION failure — no retry can fix it; the deployment must. */
function failPermanently(reason: string): void {
  const s = st();
  s.status = 'failed';
  s.reason = reason;
  console.error(`[secrets] connection-credential store MISCONFIGURED — ${reason}`);
  publishHealth();
}

/** Raise/clear the one health warning that describes what the store cannot do right now. COUNTS only. */
function publishHealth(): void {
  const s = st();
  const parts: string[] = [];
  if (s.status === 'failed') parts.push(`connection credentials cannot be stored or read (misconfigured): ${s.reason}`);
  if (s.status === 'locked') parts.push(`stored credentials are LOCKED until an admin unlocks the data key (Platform → Encryption keys): ${s.reason}`);
  if (s.status === 'unavailable') parts.push(`the credential store is not answering — retrying; until then no credential can be read or saved: ${s.reason}`);
  if (s.failedWrites.size) parts.push(`${s.failedWrites.size} credential write(s) have not reached the store yet (retrying; lost on restart until they do)`);
  if (s.tombstones.size) parts.push(`${s.tombstones.size} credential delete(s) have not reached the store yet (retrying)`);
  if (s.unreadable.size) parts.push(`${s.unreadable.size} stored credential(s) cannot be decrypted by this pod (wrong key or altered)`);
  if (s.backend?.kind === 'memory' && inCluster(process.env)) parts.push(`${SECRETS_BACKEND_ENV}=memory inside a cluster: connection credentials are NOT durable and are lost on every restart`);
  if (parts.length) setHealthWarning(SECRETS_HEALTH, `Connection secrets: ${parts.join(' | ')}`);
  else clearHealthWarning(SECRETS_HEALTH);
}

/** Select the backend + keyring once per process (lazily, so tests and `npm run dev` need nothing). */
function configure(): State {
  const s = st();
  if (s.status !== 'unconfigured') return s;
  const env = process.env;
  const chosen = (env[SECRETS_BACKEND_ENV] ?? '').trim() || (inCluster(env) ? 'kubernetes' : 'memory');
  if (chosen === 'memory') {
    s.backend = memorySecretBackend();
    try {
      s.ring = keyringFromEnv(env, true);
    } catch (e) {
      failPermanently((e as Error).message);
      return s;
    }
    s.status = 'ready'; // nothing to hydrate: a fresh process's memory store is empty by definition
    publishHealth();
    return s;
  }
  if (chosen !== 'kubernetes') {
    failPermanently(`${SECRETS_BACKEND_ENV}='${chosen}' is not a known backend (kubernetes | memory)`);
    return s;
  }
  let legacy: Keyring;
  try {
    // The env key is the BUILTIN master key now, and (decrypt-only) the key PR #334 sealed with directly.
    legacy = keyringFromEnv(env, false);
  } catch (e) {
    failPermanently(e instanceof SecretCryptoError ? e.message : String(e));
    return s;
  }
  const ns = (env[SECRETS_NAMESPACE_ENV] ?? '').trim();
  if (!ns) {
    failPermanently(`${SECRETS_NAMESPACE_ENV} is not set — the dedicated connection-secrets namespace is unknown`);
    return s;
  }
  s.backend = kubernetesSecretBackend({ namespace: ns, k8s: liveK8s });
  useEnvelope(s, kubernetesKeyStateStore({ namespace: ns, k8s: liveK8s }), env, legacy);
  s.status = 'hydrating';
  return s;
}

/** Envelope mode: the key manager supplies the keyring; the env keyring only DECRYPTS legacy values. */
function useEnvelope(s: State, store: KeyStateStore, env: NodeJS.ProcessEnv, legacy: Keyring): void {
  configureKeyManager({
    store,
    env,
    legacy: [legacy.current, ...legacy.previous],
    // First-boot guard: which keys are the stored credentials sealed under? (never mint over them)
    sealedKeyIds: async () => (await s.backend!.list()).map((r) => sealedKeyId(r.sealed)).filter((x): x is string => !!x),
  });
  s.envelope = true;
  s.legacyRing = legacy;
  s.ring = null;
}

/**
 * Envelope mode, start of every pass: (re)load the key record. Returns false while the data key is
 * locked or the record unreadable (the pass stops; nothing is served or saved).
 */
async function syncKeyring(s: State): Promise<boolean> {
  await loadKeys();
  const ring = currentKeyring();
  if (!ring) {
    const ks = keyManagerStatus();
    s.status = ks === 'locked' ? 'locked' : 'unavailable';
    s.reason = ks === 'locked' ? 'the key provider cannot unwrap the data key' : 'the key record cannot be read';
    // Writes refuse (requireWritable needs a ring); values this process already opened stay readable —
    // they were opened under a key that was valid, and dropping them would only break running agents.
    s.ring = null;
    if (ks === 'locked') {
      // Locked is not an outage — it waits for an admin. Re-check at the normal refresh pace, so the
      // other pod picks up an unlock within one period instead of a grown backoff.
      s.nextAttemptAt = Date.now() + SECRETS_REFRESH_MS;
    } else {
      s.nextAttemptAt = Date.now() + s.retryDelay;
      s.retryDelay = Math.min(s.retryDelay * 2, RETRY_MAX_MS);
    }
    publishHealth();
    return false;
  }
  const sig = (r: Keyring) => [r.current.id, ...r.previous.map((k) => k.id)].join(',');
  if (!s.ring || sig(s.ring) !== sig(ring)) {
    s.ring = ring;
    // A new keyring (rotation / switch / restore, here or on the other pod): re-open every value at the
    // next listing, so anything not under the current data key is re-sealed.
    for (const k of s.cache.keys()) s.reopen.add(k);
    s.unreadable.clear();
  }
  return true;
}

/** Apply one complete listing (started at `startedAt`) to the cache. The backend is the truth. */
function applyListing(records: SealedRecord[], startedAt: number): void {
  const s = st();
  const seen = new Set<string>();
  const reseal: SealedRecord[] = [];
  for (const r of records) {
    const k = refKey(r);
    seen.add(k);
    // This process knows better for these refs: a write in flight, a write to retry, a delete to retry,
    // or a write/delete that completed after this listing began.
    if (s.pending.has(k) || s.failedWrites.has(k) || s.tombstones.has(k) || (s.localWriteAt.get(k) ?? -1) > startedAt) continue;
    const held = s.cache.get(k);
    if (held && held.version === r.version && !s.unreadable.has(k) && !s.reopen.has(k)) continue;
    s.reopen.delete(k);
    try {
      const value = openSecret(s.ring!, r.name, r.key, r.sealed);
      s.unreadable.delete(k);
      s.cache.set(k, { value, version: r.version });
      if (sealedKeyId(r.sealed) !== s.ring!.current.id) {
        s.previousKey.add(k);
        reseal.push(r);
      } else s.previousKey.delete(k);
    } catch (e) {
      // Never guess: an unreadable value is reported (count; ref in the log) and not served.
      if (!s.unreadable.has(k)) console.error(`[secrets] stored credential ${k} cannot be decrypted (${e instanceof SecretCryptoError ? e.code : 'unreadable'})`);
      s.unreadable.set(k, e instanceof SecretCryptoError ? e.code : 'unreadable');
      s.cache.delete(k);
    }
  }
  for (const k of [...s.cache.keys()]) {
    if (seen.has(k) || s.pending.has(k) || s.failedWrites.has(k) || (s.localWriteAt.get(k) ?? -1) > startedAt) continue;
    s.cache.delete(k); // deleted by the other pod
    s.previousKey.delete(k);
  }
  for (const k of [...s.unreadable.keys()]) if (!seen.has(k)) s.unreadable.delete(k);
  for (const k of [...s.tombstones.keys()]) if (!seen.has(k)) s.tombstones.delete(k);
  // ROTATION: re-seal what the previous key sealed, conditionally (the other pod may race; one wins).
  for (const r of reseal) {
    const k = refKey(r);
    const entry = s.cache.get(k);
    if (entry) schedule(k, 'reseal', () => persist(k, entry.value, 'adopt'));
  }
}

/** One pass: (re)hydrate or refresh, then retry what has not reached the store. */
async function pass(): Promise<void> {
  const s = st();
  const startedAt = ++s.seq;
  const startedMs = Date.now();
  if (s.envelope && !(await syncKeyring(s))) return;
  try {
    const records = await s.backend!.list();
    applyListing(records, startedAt);
    // Envelope: once EVERY stored value is under the current data key (nothing pending, retried, or
    // unreadable), retired data keys nobody uses are dropped from the key record.
    if (s.envelope && s.ring && !s.pending.size && !s.failedWrites.size && !s.previousKey.size && !s.unreadable.size) {
      const inUse = new Set(records.map((r) => sealedKeyId(r.sealed)).filter((x): x is string => !!x));
      void pruneRetiredDataKeys(inUse);
    }
    s.refreshedAt = startedMs;
    if (s.status !== 'ready') {
      s.status = 'ready';
      s.reason = '';
      s.retryDelay = RETRY_MIN_MS;
      console.info(`[secrets] connection-credential store ready (${s.backend!.kind}): ${s.cache.size} credential(s) loaded${s.unreadable.size ? `, ${s.unreadable.size} unreadable` : ''}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (s.status !== 'ready') {
      // Not yet hydrated: refuse to serve or save, and try again with backoff (a blip heals).
      s.status = 'unavailable';
      s.reason = msg;
      s.nextAttemptAt = Date.now() + s.retryDelay;
      console.error(`[secrets] credential store not answering — retry in ${Math.round(s.retryDelay / 1000)} s: ${msg}`);
      s.retryDelay = Math.min(s.retryDelay * 2, RETRY_MAX_MS);
      publishHealth();
      return;
    }
    // A refresh outage after a good hydration: keep serving what is held, but say so.
    setHealthWarning(SECRETS_HEALTH, `Connection secrets: refresh failed, serving the credentials loaded at ${new Date(s.refreshedAt).toISOString()} — ${msg}`);
    return;
  }
  for (const [k, r] of [...s.failedWrites]) if (!s.pending.has(k)) schedule(k, 'write', () => persist(k, r.value, r.policy));
  for (const k of [...s.tombstones.keys()]) if (!s.pending.has(k)) schedule(k, 'delete', () => removeDurably(k));
  publishHealth();
}

/**
 * Re-read the backend into the cache (both pods; the other pod's writes and deletes arrive here) and
 * retry failed writes/deletes. `respectBackoff` (the timer) skips a not-yet-due retry of a failed boot.
 */
export async function refreshSecrets(opts: { respectBackoff?: boolean } = {}): Promise<void> {
  const s = configure();
  if (!s.backend || s.status === 'failed' || s.status === 'unconfigured') return;
  if (opts.respectBackoff && (s.status === 'unavailable' || s.status === 'locked') && Date.now() < s.nextAttemptAt) return;
  if (s.refreshing) return s.refreshing;
  s.refreshing = pass().finally(() => {
    st().refreshing = null;
  });
  return s.refreshing;
}

/** Load the store once (boot). Safe to call many times. A failure is recorded loudly, not thrown. */
export async function ensureSecretsHydrated(): Promise<void> {
  const s = configure();
  if (s.status !== 'hydrating') return;
  if (!s.hydrating) s.hydrating = refreshSecrets().finally(() => { st().hydrating = null; });
  return s.hydrating;
}

/** Re-read when the cache is older than `maxAgeMs` (the worker, before an agent tool reads a credential). */
export async function refreshSecretsIfStale(maxAgeMs = SECRETS_WORKER_MAX_AGE_MS): Promise<void> {
  const s = configure();
  if (s.backend?.kind !== 'kubernetes') return;
  if (s.status === 'hydrating') return ensureSecretsHydrated();
  if (s.status === 'unavailable' || s.status === 'locked') return refreshSecrets({ respectBackoff: true });
  if (s.status === 'ready' && Date.now() - s.refreshedAt >= maxAgeMs) await refreshSecrets();
}

/** Start the periodic refresh (and boot-retry) in THIS process. Idempotent; never holds the process open. */
export function startSecretRefresh(periodMs = SECRETS_REFRESH_MS): boolean {
  const s = configure();
  if (s.backend?.kind !== 'kubernetes' || s.status === 'failed') return false;
  if (!s.stopTimer) s.stopTimer = scheduleEvery('connection-secrets refresh', periodMs, () => refreshSecrets({ respectBackoff: true }));
  return true;
}

export type SecretStoreStatus = {
  backend: 'memory' | 'kubernetes' | null;
  status: StoreStatus;
  reason: string;
  durable: boolean;
  count: number;
  unreadable: number;
  failedWrites: number;
  pendingDeletes: number;
  sealedUnderPreviousKey: number;
  /** Stored values sealed under a key id NEITHER the key record NOR the legacy env key knows — e.g. the
   *  key record was lost or not restored. Never guessed at; Monitoring raises it. */
  unknownKey: number;
  conflictsAdopted: number;
};

/** What the store is doing — for health, Monitoring, and the needs-reconnect check. Counts only. */
export function secretStoreStatus(): SecretStoreStatus {
  const s = configure();
  return {
    backend: s.backend?.kind ?? null,
    status: s.status,
    reason: s.reason,
    durable: s.backend?.kind === 'kubernetes',
    count: s.cache.size,
    unreadable: s.unreadable.size,
    failedWrites: s.failedWrites.size,
    pendingDeletes: s.tombstones.size,
    sealedUnderPreviousKey: s.previousKey.size,
    unknownKey: [...s.unreadable.values()].filter((c) => c === 'unknown-key').length,
    conflictsAdopted: s.conflictsAdopted,
  };
}

/** True once the store holds everything the backend held — only then does "absent" mean "lost". */
export function secretStoreReady(): boolean {
  return configure().status === 'ready';
}

function requireWritable(): State {
  const s = configure();
  if (s.status !== 'ready' || !s.backend || !s.ring) {
    throw new SecretStoreUnavailableError(`The connection-credential store is ${s.status === 'failed' ? 'misconfigured' : s.status === 'locked' ? 'locked (an admin must unlock the data key under Platform → Encryption keys)' : 'not available'}, so nothing was saved: ${s.reason || s.status}`);
  }
  return s;
}

/** Chain an operation for one ref after whatever is already pending for it. */
function schedule(k: string, op: string, run: () => Promise<void>): void {
  const s = st();
  const prior = s.pending.get(k) ?? Promise.resolve();
  const tracked: Promise<void> = prior
    .then(run)
    .catch((e: unknown) => console.error(`[secrets] ${op} of ${k} failed unexpectedly — ${e instanceof Error ? e.message : String(e)}`))
    .finally(() => {
      if (s.pending.get(k) === tracked) s.pending.delete(k);
      publishHealth();
    });
  s.pending.set(k, tracked);
}

/** Write the cached value durably, conditional on the version this process last saw. Never throws. */
async function persist(k: string, value: string, policy: ConflictPolicy): Promise<void> {
  const s = st();
  const ref = splitKey(k);
  const write = async (expected: string | null) => {
    const { version } = await s.backend!.write({ ...ref, sealed: sealSecret(s.ring!, ref.name, ref.key, value) }, expected);
    // The backend's version now — the expected version for this ref's next (possibly already queued) write.
    const cur = s.cache.get(k);
    if (cur) cur.version = version;
    s.previousKey.delete(k);
  };
  try {
    // Deleted here after this write was queued: writing it now would bring the credential back.
    if (!s.cache.has(k) || s.tombstones.has(k)) return;
    try {
      await write(s.cache.get(k)?.version ?? null);
    } catch (e) {
      if (!(e instanceof SecretConflictError)) throw e;
      const current = await s.backend!.read(ref);
      if (policy === 'adopt' && !current) {
        // Deleted by the other pod (the connection was removed) while we refreshed its token: a
        // background refresh must never resurrect it. Drop it here too.
        const cur = s.cache.get(k);
        if (!cur || cur.value === value) s.cache.delete(k);
        console.info(`[secrets] ${k}: deleted elsewhere during a background refresh — not re-created`);
      } else if (policy === 'adopt' && current) {
        // Another writer got there first (e.g. the other pod refreshed the same OAuth token): its value wins.
        const theirs = openSecret(s.ring!, ref.name, ref.key, current.sealed);
        const cur = s.cache.get(k);
        if (!cur || cur.value === value) s.cache.set(k, { value: theirs, version: current.version });
        s.conflictsAdopted++;
        console.info(`[secrets] ${k}: another writer changed it first — adopted its value`);
      } else {
        await write(current ? current.version : null); // explicit save: overwrite what is there now, once
      }
    }
    s.failedWrites.delete(k);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!s.failedWrites.has(k)) console.error(`[secrets] write of credential ${k} did NOT reach the store — will retry: ${msg}`); // the ref, never the value
    // Only the latest value is retried.
    if (s.cache.get(k)?.value === value) s.failedWrites.set(k, { value, policy, error: msg });
  } finally {
    s.localWriteAt.set(k, ++s.seq);
  }
}

async function removeDurably(k: string): Promise<void> {
  const s = st();
  try {
    await s.backend!.remove(splitKey(k));
    s.tombstones.delete(k);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!s.tombstones.get(k)) console.error(`[secrets] delete of credential ${k} did NOT reach the store — will retry: ${msg}`);
    s.tombstones.set(k, msg);
  } finally {
    s.localWriteAt.set(k, ++s.seq);
  }
}

/**
 * Write a credential. Returns ONLY a reference. Durable write-through; see {@link awaitSecretWrites}.
 * `policy` decides a concurrent-write conflict: 'overwrite' (default — a person's explicit save) or
 * 'adopt' (a background token refresh: the value another pod already stored wins).
 */
export function putSecret(name: string, key: string, value: string, policy: ConflictPolicy = 'overwrite'): SecretRef {
  const s = requireWritable();
  if (Buffer.byteLength(value, 'utf8') > MAX_SECRET_VALUE_BYTES) {
    throw Object.assign(new Error(`The credential is too large to store (${Buffer.byteLength(value, 'utf8')} bytes; the limit is ${MAX_SECRET_VALUE_BYTES}). Paste only the token or key itself.`), { status: 400 });
  }
  const ref = { name, key };
  const k = refKey(ref);
  const held = s.cache.get(k);
  s.cache.set(k, { value, version: held?.version ?? null });
  s.tombstones.delete(k);
  s.failedWrites.delete(k);
  schedule(k, 'write', () => persist(k, value, policy));
  return ref;
}

/**
 * Wait for this process's writes/deletes (all, or for `refs`). Throws `SecretStoreUnavailableError`
 * when any has not reached the store — so a create/rotate path refuses instead of claiming a
 * credential is saved that will vanish on the next restart. (The write stays queued for retry.)
 */
export async function awaitSecretWrites(refs?: SecretRef[]): Promise<void> {
  const s = st();
  const keys = refs ? refs.map(refKey) : [...s.pending.keys()];
  await Promise.all(keys.map((k) => s.pending.get(k)).filter(Boolean));
  const failed = keys.filter((k) => s.failedWrites.has(k) || s.tombstones.has(k));
  if (failed.length) {
    const why = failed.map((k) => s.failedWrites.get(k)?.error ?? s.tombstones.get(k)).filter(Boolean)[0];
    throw new SecretStoreUnavailableError(`The credential could not be saved durably (${failed.length} pending; ${why})`);
  }
}

export function hasSecret(ref: SecretRef): boolean {
  return configure().cache.has(refKey(ref));
}

/** Is ANY key stored under this secret name? (A warehouse connection keeps one key per field.) */
export function hasAnySecretUnder(name: string): boolean {
  const prefix = `${name}/`;
  for (const k of configure().cache.keys()) if (k.startsWith(prefix)) return true;
  return false;
}

/**
 * A non-reversible, KEYED fingerprint of the stored secret — safe to show/audit. HMAC-SHA256 under a
 * key derived from the deployment's encryption secret, so it cannot be used to test guesses offline.
 */
export function secretFingerprint(ref: SecretRef): string {
  const s = configure();
  const v = s.cache.get(refKey(ref))?.value;
  const ring = s.legacyRing ?? s.ring;
  if (!v || !ring) return '';
  return fingerprintSecret(ring, v);
}

/**
 * Retrieve a secret SERVER-SIDE only (e.g. for the connection proxy to inject the credential into an
 * outbound call, or to "test" the connection). Callers must never return this value to the client or
 * put it in a trace. Null when absent — including a credential lost before this store was durable
 * (the connection then reads `needs-reconnect`, see the Connections store).
 */
export function getSecretServerSide(ref: SecretRef): string | null {
  return configure().cache.get(refKey(ref))?.value ?? null;
}

/** Delete a credential — by NAME in the backend, whether or not this process had it cached. */
export function deleteSecret(ref: SecretRef): void {
  const s = requireWritable();
  const k = refKey(ref);
  s.cache.delete(k);
  s.failedWrites.delete(k);
  s.previousKey.delete(k);
  s.tombstones.set(k, '');
  schedule(k, 'delete', () => removeDurably(k));
}

/**
 * TEST HOOK: make THIS (simulated) process use `backend` + an `env`-derived keyring, with an empty
 * cache — i.e. a fresh process instance. Call `ensureSecretsHydrated()` afterwards to boot it.
 */
export function __configureSecretStoreForTests(backend: SecretBackend | null, env: NodeJS.ProcessEnv = process.env, opts: { keyStore?: KeyStateStore } = {}): void {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  g[STATE_KEY]?.stopTimer?.();
  delete g[STATE_KEY];
  clearHealthWarning(SECRETS_HEALTH);
  if (!backend) return; // back to lazy env-based selection
  const s = st();
  s.backend = backend;
  try {
    s.ring = keyringFromEnv(env, backend.kind === 'memory');
  } catch (e) {
    failPermanently((e as Error).message);
    return;
  }
  if (opts.keyStore) useEnvelope(s, opts.keyStore, env, s.ring);
  s.status = 'hydrating';
}

/** After an admin key operation in THIS process: adopt the new keyring now (the other pod follows on its next refresh). */
export async function reloadSecretKeys(): Promise<void> {
  const s = configure();
  if (!s.envelope) return;
  s.nextAttemptAt = 0;
  await refreshSecrets();
}

// ------------------------------------------------------------- Egress allowlist --

/**
 * Egress allowlist guardrail (security.md). External endpoints must be on the
 * tenant allowlist (an Admin guardrail; the chart's `egressProxy.allowlist`). We
 * mirror it here so the guardrail is demonstrable offline; the live source of
 * truth is the egress proxy + Cilium FQDN policy.
 */
const DEFAULT_ALLOWLIST = [
  'example.com',
  'github.com',
  // Connections golden-path slice endpoints (also added to egressProxy.allowlist).
  'salesforce.com',
  'my.salesforce.com',
  'login.salesforce.com',
  'notion.com',
  'mcp.notion.com',
  'api.notion.com',
  // Connected-drive OAuth flow: the Google + Microsoft OAuth token endpoints and
  // the Drive / Microsoft Graph APIs the connector reads from (also add these to
  // egressProxy.allowlist + the Cilium FQDN policy on a real deploy).
  'googleapis.com', // www.googleapis.com (Drive) + oauth2.googleapis.com (token)
  'accounts.google.com', // Google authorize endpoint
  'graph.microsoft.com', // OneDrive via Microsoft Graph
  'login.microsoftonline.com', // Microsoft OAuth authorize + token endpoints
  // Connector wave — hand-built typed API clients (each host also added to the chart
  // egressProxy.allowlist + Cilium FQDN policy on a real deploy).
  'api.github.com', // GitHub REST + GraphQL (covered by github.com, listed explicitly)
  'uploads.github.com', // GitHub release/asset uploads
  'api.supabase.com', // Supabase Management API (projects/tables/migrations/advisors/logs)
  'atlassian.net', // Jira + Confluence Cloud sites (*.atlassian.net via subdomain rule)
  'api.atlassian.com', // Atlassian OAuth 3LO gateway (cloudId-scoped API)
  'auth.atlassian.com', // Atlassian OAuth token endpoint
  // Messaging + calendar wave — hand-built typed API clients (bot token / user-provided
  // OAuth access token). Each host also added to the chart egressProxy.allowlist +
  // Cilium FQDN policy on a real deploy.
  'slack.com', // Slack Web API (slack.com/api) + www.slack.com
  'gmail.googleapis.com', // Gmail API
  'oauth2.googleapis.com', // Google OAuth token endpoint (token refresh follow-up)
  // googleapis.com (above) already covers www.googleapis.com — Google Calendar API
  // graph.microsoft.com (above) already covers Outlook + Teams over Microsoft Graph
  // login.microsoftonline.com (above) already covers Microsoft OAuth token endpoint
  // Cloud key-services wave — governance / identity / ML metadata connectors (each
  // host also added to the chart egressProxy.allowlist + Cilium FQDN policy on a
  // real deploy). Entra reuses graph.microsoft.com (already above) — no new host.
  'purview.azure.com', // Microsoft Purview (<account>.purview.azure.com via subdomain rule)
  'api.azureml.ms', // Azure AI Foundry / Azure ML data plane (<region>.api.azureml.ms)
  'ml.azure.com', // Azure ML control-plane / OAuth audience host
  'amazonaws.com', // AWS SageMaker (api.sagemaker.<region>.amazonaws.com via subdomain rule)
  // Cloud key-services wave 2 — GCP identity/IAM governance + Snowflake ACCOUNT_USAGE
  // governance (each host also added to the chart egressProxy.allowlist + Cilium FQDN
  // policy on a real deploy — the operator's step, #176).
  'cloudresourcemanager.googleapis.com', // GCP Cloud Resource Manager (list projects, getIamPolicy)
  'iam.googleapis.com', // GCP IAM (service accounts)
  'admin.googleapis.com', // GCP Admin SDK (optional org/directory reads — reserved)
  // oauth2.googleapis.com (above) already covers the GCP JWT-bearer token exchange
  'snowflakecomputing.com', // Snowflake SQL REST API (<account>.snowflakecomputing.com via subdomain rule)
  // Kajabi public API — sync source (api-batch strategy). Token endpoint + data
  // API share the one host (also added to the chart egressProxy.allowlist +
  // deploy/egress-connectors-overlay.yaml).
  'api.kajabi.com',
  // Operational systems wave — SAP S/4HANA Cloud OData + generic OData V4 (Dynamics 365 /
  // Business Central) + Workday RaaS. Cloud-reachable services only; a customer-specific
  // host not covered here still passes via an Admin-approved egress request. (Also add to
  // the chart egressProxy.allowlist + Cilium FQDN policy on a real deploy.)
  's4hana.cloud.sap', // SAP S/4HANA Cloud (<tenant>.s4hana.cloud.sap via subdomain rule)
  'sap-oauth.cloud.sap', // SAP BTP OAuth token endpoints (client-credentials)
  'ondemand.com', // SAP BTP / Business Technology Platform hosts (*.ondemand.com)
  'sandbox.api.sap.com', // SAP API Business Hub sandbox (public-sandbox verification)
  'api.businesscentral.dynamics.com', // Microsoft Dynamics 365 Business Central OData
  'dynamics.com', // Microsoft Dynamics 365 (<org>.crm.dynamics.com via subdomain rule)
  'workday.com', // Workday RaaS tenant hosts (*.workday.com via subdomain rule)
  'myworkday.com', // Workday RaaS tenant hosts (*.myworkday.com via subdomain rule)
];

function allowlist(): string[] {
  const csv = process.env.OS_EGRESS_ALLOWLIST;
  if (csv && csv.trim().length > 0) {
    return csv.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return DEFAULT_ALLOWLIST;
}

export function egressHost(endpoint: string): string {
  const raw = (endpoint || '').trim();
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return u.hostname.toLowerCase();
  } catch {
    return raw.replace(/^[a-z]+:\/\//i, '').split('/')[0].split(':')[0].toLowerCase();
  }
}

/**
 * Strip the surrounding brackets an IPv6 URL host carries (`[::1]` → `::1`) and
 * lowercase, so the literal-IP matchers below see a bare address.
 */
function bareAddr(host: string): string {
  return host.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
}

/**
 * HARD-DENIED egress targets — refused ALWAYS, even if explicitly allowlisted.
 * These IP literals are never a legitimate connector destination and are the
 * classic SSRF pivots:
 *   • cloud-metadata `169.254.169.254` + the whole link-local `169.254.0.0/16`
 *   • IPv4 loopback `127.0.0.0/8`
 *   • IPv6 loopback `::1`
 *   • IPv4-mapped-IPv6 forms of the above (`::ffff:127.0.0.1`, `::ffff:169.254.x`,
 *     and the dotless hex form `::ffff:a9fe:a9fe` for 169.254.169.254)
 * (`localhost` is handled as an internal NAME below; it can be an allowlisted
 * escape-hatch dev target, whereas a raw loopback/metadata literal never is.)
 */
export function isHardDeniedTarget(endpoint: string): boolean {
  const host = bareAddr(egressHost(endpoint));
  if (!host) return false;
  if (host === '::1') return true; // IPv6 loopback
  if (/^127\.\d+\.\d+\.\d+$/.test(host)) return true; // IPv4 loopback 127.0.0.0/8
  if (/^169\.254\.\d+\.\d+$/.test(host)) return true; // link-local incl. metadata 169.254.169.254
  // IPv4-mapped IPv6 (dotted tail): ::ffff:127.0.0.1 / ::ffff:169.254.169.254
  const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped && isHardDeniedTarget(mapped[1])) return true;
  // IPv4-mapped IPv6 (hex tail): ::ffff:7f00:1 (127.0.0.1), ::ffff:a9fe:a9fe (169.254.169.254)
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    const oct = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    if (isHardDeniedTarget(oct)) return true;
  }
  return false;
}

/** Is `host` an RFC1918 private IPv4 literal (10/8, 172.16-31/12, 192.168/16)? */
function isRfc1918(host: string): boolean {
  const h = bareAddr(host);
  if (/^10\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(h)) return true;
  const m = h.match(/^172\.(\d+)\.\d+\.\d+$/);
  if (m) {
    const second = Number(m[1]);
    return second >= 16 && second <= 31;
  }
  return false;
}

/**
 * Is this host an INTERNAL / in-cluster / loopback / private target? These are the
 * hosts a user-supplied connector endpoint must NOT be able to reach by default —
 * reaching an in-cluster service (`query-tool`, `trino`, `opa`, `minio`,
 * `kubernetes.default`), loopback, or a private RFC1918 address would be a
 * server-side request forgery (SSRF) into the platform / private network.
 *
 * ACTUAL POLICY (two tiers):
 *   • HARD-DENIED (never egressable, even if allowlisted) — see
 *     `isHardDeniedTarget`: cloud-metadata / link-local `169.254.0.0/16`, loopback
 *     `127.0.0.0/8` + `::1`, and IPv4-mapped-IPv6 forms of these.
 *   • ALLOWLIST-GATED internal (denied UNLESS explicitly allowlisted — legit
 *     on-prem warehouses on RFC1918 may be allowlisted): bare hostnames (no dot,
 *     e.g. `opa`), `*.svc` / `*.cluster.local` / `*.local`, `localhost`, IPv6
 *     link-local `fe80::/10`, and RFC1918 literals (`10/8`, `172.16-31/12`,
 *     `192.168/16`).
 * The real egress enforcement is defence-in-depth OUTSIDE this function too — the
 * egress proxy plus the Cilium FQDN policy at the network boundary.
 */
export function isInternalTarget(endpoint: string): boolean {
  const host = egressHost(endpoint);
  if (!host) return true; // un-parseable / empty → treat as internal (deny by default)
  if (isHardDeniedTarget(endpoint)) return true;
  if (host === 'localhost') return true;
  if (/^\[?fe80:/i.test(host)) return true; // IPv6 link-local fe80::/10
  if (isRfc1918(host)) return true; // private RFC1918 IPv4 literal (allowlist-gated)
  if (/\.(local|cluster\.local|svc)$/.test(host)) return true; // in-cluster / local dev
  if (!host.includes('.')) return true; // bare service name (e.g. "opa", "query-tool")
  return false;
}

/** An endpoint is "external" unless it targets an in-cluster / local host. */
export function isExternal(endpoint: string): boolean {
  const host = egressHost(endpoint);
  if (!host) return false;
  return !isInternalTarget(endpoint);
}

/** Is `host` explicitly present on the egress allowlist (or an Admin-approved request)? */
function onAllowlist(host: string): boolean {
  const list = allowlist();
  return list.some((d) => host === d || host.endsWith(`.${d}`)) || isHostApproved(host);
}

/**
 * Is this endpoint permitted to egress? Subdomains of an allowlisted host pass.
 *
 * DENY-BY-DEFAULT for internal targets: an in-cluster / loopback host is refused
 * UNLESS it is explicitly on the egress allowlist. This closes the SSRF where a
 * signed-in user creates a connector with `endpoint: http://query-tool:8080` (or
 * trino/opa/minio/kubernetes.default.svc) and gets a server-side fetch to an internal
 * service. External hosts still require the allowlist as before.
 */
export function isEgressAllowed(endpoint: string): { external: boolean; host: string; allowed: boolean } {
  const host = egressHost(endpoint);
  // Hard-denied literals (cloud-metadata / link-local / loopback, incl. IPv4-mapped
  // IPv6) are refused ALWAYS — the allowlist cannot re-enable them (SSRF pivots).
  if (isHardDeniedTarget(endpoint)) {
    return { external: false, host, allowed: false };
  }
  const internal = isInternalTarget(endpoint);
  if (internal) {
    // Internal targets are denied unless the operator EXPLICITLY allowlisted them.
    return { external: false, host, allowed: onAllowlist(host) };
  }
  // Allowed if on the static Admin allowlist OR an Admin-approved egress request.
  return { external: true, host, allowed: onAllowlist(host) };
}
