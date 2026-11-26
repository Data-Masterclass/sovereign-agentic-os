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

export type KeyHistoryEntry = { at: string; actor: string; action: string; detail: string };

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
}

export const KEYRING_SECRET = 'os-conn-keyring';
export const KEYRING_LABELS = { 'app.kubernetes.io/managed-by': 'os-ui', 'app.kubernetes.io/component': 'connection-keyring' } as const;
export const ANN_PROVIDER = 'sovereign-os.io/key-provider';

export function memoryKeyStateStore(): KeyStateStore & { peek(): KeyRecord | null } {
  let cur: { record: KeyRecord; version: string } | null = null;
  let n = 0;
  return {
    kind: 'memory',
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
  return {
    kind: 'kubernetes',
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
