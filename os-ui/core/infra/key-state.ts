/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The durable KEY RECORD of the connection-credential store (wrapped data keys, provider, recovery verifier)
 * USER STORY: As an operator I want the wrapped data keys to live next to the ciphertext — so a backup
 *             of the credentials can be opened again with the master key or the recovery key — while
 *             no clear key is ever stored anywhere.
 * ARCHITECTURE:
 *   - ONE record per installation: the active provider (id + non-secret config + its credential
 *     SEALED under the builtin KEK), every data key (current first, retired after it — kept so values
 *     sealed under an older key stay readable until re-sealed), each data key wrapped by the provider
 *     AND (once a recovery key exists) to the recovery public key, the recovery verifier and when it
 *     was confirmed, the admin's recovery CHOICE (none / recovery key — absent until one is made), and a short history of key operations (who, what, when — no material).
 *   - `kubernetesKeyStateStore`: ONE Secret `os-conn-keyring` in the dedicated conn-secrets namespace
 *     (the namespace the store's Role already covers — no new RBAC), labelled
 *     `app.kubernetes.io/component=connection-keyring` so the credential listing never sees it.
 *     The annotation `sovereign-os.io/key-provider` is informational; the release smoke test reads the
 *     app's MAC-verified state from /api/health (`connectionKeys`), never a raw annotation. Velero backs this
 *     namespace up: a backup holds ciphertext + WRAPPED keys, never a master key or a clear data key.
 *   - Conditional writes on `resourceVersion` (create-only when absent): two pods that boot together
 *     cannot both mint a data key, and an admin change never overwrites a newer one.
 */
import type { K8sCall } from '@core/infra/secret-backend';
import { SecretBackendError, SecretConflictError } from '@core/infra/secret-backend';
import type { KeyProviderId } from '@core/infra/key-providers';
import { createHash } from 'crypto';

export type WrappedDataKey = {
  id: string;
  /** The provider's wrap (opaque). */
  wrapped: string;
  /** Which provider made `wrapped` (a switch re-wraps every key). */
  provider: KeyProviderId;
  /** The wrap to the recovery public key, once a recovery key exists. */
  recovery?: string;
  createdAt: string;
};

/** `unverified`: carried over from a record that failed its integrity check (a start-over) — shown as such.
 *  History is informational and never part of the MAC, so nothing is decided from it. */
export type KeyHistoryEntry = { at: string; actor: string; action: string; detail: string; unverified?: boolean };

/** What a start-over set aside: the previous record's wrapped data keys, recovery wraps/verifiers and provider
 *  entry, kept AS THEY WERE (still wrapped — no clear key) so that a master key or recovery key found later can
 *  still open the values sealed under them. Taken from a record that could NOT be verified: never trusted for
 *  anything automatic. The archive as a whole is signed by the NEW record's MAC (it cannot be swapped later),
 *  but each entry's CONTENT is untrusted — a future archive-unlock MUST verify each entry's own `mac` under the
 *  key that was found (recordMacMaterial over the entry) before using any wrap, verifier or provider config. */
export type ArchivedKeyRecord = {
  archivedAt: string;
  archivedBy: string;
  reason: string;
  provider: KeyRecord['provider'];
  dataKeys: WrappedDataKey[];
  recovery?: KeyRecord['recovery'];
  pendingRecovery?: KeyRecord['pendingRecovery'];
  recoveryChoice?: KeyRecord['recoveryChoice'];
  mac?: string;
};

/** "This process opened the key record whose MAC is `mac` at `at`" — written by every process that holds
 *  the keys (throttled). A start-over is refused while another process recently opened the very record this
 *  one cannot: then the record is healthy and THIS process has the wrong master key. Forging an entry can
 *  only block a start-over (the safe direction). */
export type KeySeenEntry = { process: string; at: string; mac: string };

export type KeyRecord = {
  v: 1;
  provider: { id: KeyProviderId; config: Record<string, string>; credential?: string };
  /** Current data key first. */
  dataKeys: WrappedDataKey[];
  /** The CONFIRMED recovery key's verifier (every data key carries a wrap to it). */
  recovery?: { id: string; salt: string; publicKey: string; createdAt: string; createdBy: string; confirmedAt?: string; confirmedBy?: string };
  /** A generated recovery key nobody confirmed yet. It replaces `recovery` only on "I saved it", so a lost
   *  dialog never invalidates a key that is already saved. */
  pendingRecovery?: { id: string; salt: string; publicKey: string; createdAt: string; createdBy: string };
  /** The admin's explicit RECOVERY CHOICE (Platform → Encryption keys → Recovery). Absent = no choice made yet
   *  (a new install). `none` = an admin acknowledged that without a recovery key a lost master key means
   *  reconnecting every connection; `recovery-key` = set when a recovery key is confirmed. Signed (MAC). */
  recoveryChoice?: { mode: 'none' | 'recovery-key'; at: string; by: string };
  /** Earlier records set aside by a start-over (newest last, at most 3). Covered by the MAC once present. */
  archive?: ArchivedKeyRecord[];
  history: KeyHistoryEntry[];
  updatedAt: string;
  /** HMAC over the security-relevant fields under the builtin master key (key-providers.ts recordMacMaterial). */
  mac?: string;
};

export interface KeyStateStore {
  readonly kind: 'memory' | 'kubernetes';
  read(): Promise<{ record: KeyRecord; version: string } | null>;
  /** expected null = create only. Throws SecretConflictError when it moved. */
  write(record: KeyRecord, expected: string | null): Promise<{ version: string }>;
  /** Which processes recently opened which record (see KeySeenEntry). Absent → a start-over is refused. */
  readonly seen?: { write(e: KeySeenEntry): Promise<void>; list(): Promise<KeySeenEntry[]> };
}

export const KEYRING_SECRET = 'os-conn-keyring';
export const KEYRING_LABELS = { 'app.kubernetes.io/managed-by': 'os-ui', 'app.kubernetes.io/component': 'connection-keyring' } as const;
export const ANN_PROVIDER = 'sovereign-os.io/key-provider';
export const SEEN_LABELS = { 'app.kubernetes.io/managed-by': 'os-ui', 'app.kubernetes.io/component': 'connection-keyring-seen' } as const;
/** Markers older than this are deleted when the markers are listed (every process id is new after a restart,
 *  so without pruning one Secret per pod start would pile up forever). Far beyond the 10-minute window. */
export const SEEN_PRUNE_MS = 24 * 60 * 60_000;
const stale = (at: string, nowMs: number) => !(nowMs - Date.parse(at) < SEEN_PRUNE_MS); // unparsable time = stale

/** A seen marker's JSON, or null when it is not one (checked shape; JSON.parse errors are a "not one"). */
function parseSeen(b64: string | undefined): KeySeenEntry | null {
  const raw = Buffer.from(b64 ?? '', 'base64').toString('utf8');
  if (!/^\{[\s\S]*\}$/.test(raw.trim())) return null;
  let e: Partial<KeySeenEntry>;
  try {
    e = JSON.parse(raw) as Partial<KeySeenEntry>;
  } catch (err) {
    console.warn(`[keys] unparsable seen marker: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  return typeof e.process === 'string' && typeof e.at === 'string' && typeof e.mac === 'string' ? { process: e.process, at: e.at, mac: e.mac } : null;
}

export function memoryKeyStateStore(): KeyStateStore & { peek(): KeyRecord | null } {
  let cur: { record: KeyRecord; version: string } | null = null;
  let n = 0;
  const seen = new Map<string, KeySeenEntry>();
  return {
    kind: 'memory',
    seen: {
      async write(e) {
        seen.set(e.process, { ...e });
      },
      async list() {
        const nowMs = Date.now();
        for (const [k, e] of seen) if (stale(e.at, nowMs)) seen.delete(k);
        return [...seen.values()].map((e) => ({ ...e }));
      },
    },
    async read() {
      return cur ? { record: structuredClone(cur.record), version: cur.version } : null;
    },
    async write(record, expected) {
      if (expected === null ? cur !== null : cur?.version !== expected) throw new SecretConflictError('key record changed');
      cur = { record: structuredClone(record), version: String(++n) };
      return { version: cur.version };
    },
    peek: () => (cur ? structuredClone(cur.record) : null),
  };
}

export function kubernetesKeyStateStore(opts: { namespace: string; k8s: K8sCall }): KeyStateStore {
  const base = `/api/v1/namespaces/${encodeURIComponent(opts.namespace)}/secrets`;
  const manifest = (record: KeyRecord, rv?: string) => ({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: KEYRING_SECRET,
      namespace: opts.namespace,
      ...(rv ? { resourceVersion: rv } : {}),
      labels: { ...KEYRING_LABELS },
      // Informational only — the release check reads the app's MAC-verified state (/api/health), not this.
      annotations: { [ANN_PROVIDER]: record.provider.id },
    },
    type: 'Opaque',
    // Wrapped keys, the recovery VERIFIER and a sealed provider credential only — no clear key.
    data: { state: Buffer.from(JSON.stringify(record), 'utf8').toString('base64') },
  });
  const why = (op: string, status: number) =>
    new SecretBackendError(status, `key record: cannot ${op} Secret ${KEYRING_SECRET} — ${status === 403 || status === 401 ? 'the ServiceAccount lacks the conn-secrets Role' : `the Kubernetes API answered ${status}`}`);
  const selector = Object.entries(SEEN_LABELS).map(([k, v]) => `${k}=${v}`).join(',');
  // One small Secret per process (name = a hash of the process id): no write contention with the record.
  const seenName = (proc: string) => `os-conn-keyring-seen-${createHash('sha256').update(proc).digest('hex').slice(0, 16)}`;
  return {
    kind: 'kubernetes',
    seen: {
      async write(e) {
        const name = seenName(e.process);
        const body = { apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace: opts.namespace, labels: { ...SEEN_LABELS } }, type: 'Opaque', data: { seen: Buffer.from(JSON.stringify(e), 'utf8').toString('base64') } };
        let res = await opts.k8s('PUT', `${base}/${name}`, body);
        if (res.status === 404) res = await opts.k8s('POST', base, body);
        if (res.status < 200 || res.status >= 300) throw why('write the seen marker', res.status);
      },
      async list() {
        const res = await opts.k8s('GET', `${base}?labelSelector=${encodeURIComponent(selector)}`);
        if (res.status < 200 || res.status >= 300) throw why('list the seen markers', res.status);
        const out: KeySeenEntry[] = [];
        const prune: string[] = [];
        let malformed = 0;
        const nowMs = Date.now();
        for (const it of ((res.body as { items?: { metadata?: { name?: string }; data?: { seen?: string } }[] }).items ?? [])) {
          const e = parseSeen(it.data?.seen);
          if (!e) malformed++;
          if (!e || stale(e.at, nowMs)) {
            if (it.metadata?.name) prune.push(it.metadata.name);
            continue;
          }
          out.push(e);
        }
        // A malformed marker proves nothing either way; it is pruned like an old one.
        if (malformed) console.warn(`[keys] ${malformed} malformed seen marker(s) ignored`);
        // PRUNE in the background: the caller never waits on the deletes; a failed delete is retried next list.
        if (prune.length) {
          void Promise.allSettled(prune.map((n) => opts.k8s('DELETE', `${base}/${n}`))).then((rs) => {
            const failed = rs.filter((r) => r.status === 'rejected' || (r.value.status >= 300 && r.value.status !== 404)).length;
            if (failed) console.warn(`[keys] ${failed} of ${prune.length} old seen marker(s) could not be deleted (retried on the next list)`);
          });
        }
        return out;
      },
    },
    async read() {
      const res = await opts.k8s('GET', `${base}/${KEYRING_SECRET}`);
      if (res.status === 404) return null;
      if (res.status < 200 || res.status >= 300) throw why('read', res.status);
      const b = res.body as { metadata?: { resourceVersion?: string }; data?: { state?: string } };
      if (!b.data?.state) throw new SecretBackendError(500, `key record: Secret ${KEYRING_SECRET} has no state`);
      return { record: JSON.parse(Buffer.from(b.data.state, 'base64').toString('utf8')) as KeyRecord, version: String(b.metadata?.resourceVersion ?? '') };
    },
    async write(record, expected) {
      const res = expected === null ? await opts.k8s('POST', base, manifest(record)) : await opts.k8s('PUT', `${base}/${KEYRING_SECRET}`, manifest(record, expected));
      if (res.status === 409 || (expected !== null && res.status === 404)) throw new SecretConflictError('key record changed');
      if (res.status < 200 || res.status >= 300) throw why(expected === null ? 'create' : 'update', res.status);
      return { version: String(((res.body.metadata ?? {}) as { resourceVersion?: string }).resourceVersion ?? '') };
    },
  };
}
