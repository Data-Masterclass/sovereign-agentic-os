/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The model key of ONE agent system: a random value, stored encrypted where
 *             every process that runs the system can read it.
 *
 * USER STORY: As a platform admin, the budget and the limits I set per agent system really
 *             apply, because every run of that system calls the model with the system's
 *             own key — in the web process, in the worker, and after any restart.
 *             As a security reviewer, knowing a system's id tells me nothing about its key:
 *             the value is 32 random bytes, and at rest it is ciphertext.
 *             As a system owner, when my system has no usable key I am told to press
 *             Build, instead of my run quietly spending on a key shared by everyone.
 *
 * ARCHITECTURE:
 *   THE VALUE.  `mintSystemKey()` is `sk-` + 32 bytes from the OS CSPRNG (base64url). It is
 *   never derived from an id. The predecessor was `sk-os-<systemId>` — guessable by anyone
 *   who knew a system id; `legacyDerivedKey` exists only so Build and the sweep can
 *   recognise and delete that old key (by its hash — the value is never sent anywhere).
 *
 *   THE STORE.  One row per system in `agent_system_keys`, in the `agent_runs` Postgres
 *   database (`AGENT_RUNS_DATABASE_URL`) — the one store os-ui web AND the `os-ui-worker`
 *   already share for `run_jobs`, `run_events` and the LangGraph checkpoints. Not a
 *   Kubernetes Secret (os-ui would need write RBAC on Secrets, and the worker would need a
 *   restart or a watch to see a new one) and not the OpenSearch mirror (a search index is
 *   not a place for credentials). The DDL is idempotent and runs once per process, the
 *   same contract as `engine/jobs-postgres.ts`. With no database configured (a laptop,
 *   one process) the store is an in-memory map, like the run queue itself.
 *
 *   AT REST.  AES-256-GCM, a fresh random 96-bit nonce per record, and the system id +
 *   alias as additional authenticated data, so a row copied onto another system does not
 *   decrypt. The key-encryption key is derived (HKDF-SHA256) from a DEDICATED secret,
 *   `AGENT_KEY_ENCRYPTION_KEY` — not the LiteLLM master key and not derived from it, so
 *   the worker can decrypt without ever holding gateway admin. Each row records which
 *   secret sealed it (`kek_id`), so a changed secret reads as "unreadable — rebuild",
 *   not as a garbled key.
 *
 *   THE READ.  `resolveSystemKey` decrypts in memory for the model call and returns the
 *   value to that caller only. It throws `SystemKeyUnavailableError` when there is no
 *   usable key; it never substitutes another credential. Nothing here logs a key, and
 *   `systemKeyStatus` — what the UI and the admin view read — carries no key material.
 */
import 'server-only';
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'crypto';
import { config } from '@core/kernel/config';
import { agentRunsPool, configuredAgentRunsDatabaseUrl } from '@core/adapters/postgres/pool';

// ------------------------------------------------------------------ the value --

/** The alias of a system's key in the gateway — stable and readable: `os-<systemId>`. */
export function systemKeyAlias(systemId: string): string {
  return `os-${systemId}`;
}

/** A NEW key value: `sk-` (the prefix LiteLLM requires of a caller-supplied key) + 32 CSPRNG bytes. */
export function mintSystemKey(): string {
  return `sk-${randomBytes(32).toString('base64url')}`;
}

/** LiteLLM's id for a key (its `token`): the SHA-256 of the key value, hex. Safe to store and to log. */
export function tokenIdOf(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** The value the OS USED to give a key: `sk-<alias>`. Only ever hashed, to recognise an old key. */
export function legacyDerivedKey(alias: string): string {
  return `sk-${alias}`;
}

/**
 * The alias an old key is moved to while its replacement is registered (LiteLLM requires unique
 * aliases). Deterministic from the token id, so a resumed replacement finds the key again.
 */
export function retiringAlias(alias: string, tokenId: string): string {
  return `${alias}.retiring.${tokenId.slice(0, 12)}`;
}

/** Is the gateway key with this alias and token id the old, guessable one? */
export function isLegacyDerivedToken(alias: string, tokenId: string | undefined | null): boolean {
  return Boolean(tokenId) && tokenId === tokenIdOf(legacyDerivedKey(alias));
}

// ------------------------------------------------------------------ at rest ----

/** The caps a key was created or last updated with — shown to admins, never enforced from here. */
export type SystemKeyCaps = {
  models: string[];
  maxBudget: number;
  budgetDuration: string;
  rpmLimit: number;
  tpmLimit: number;
  maxParallelRequests: number;
};

/** One stored row. Everything in it is safe to list EXCEPT that `ciphertext` must stay sealed. */
export type SystemKeyRecord = {
  systemId: string;
  alias: string;
  /** LiteLLM's token id (SHA-256 of the key) — how the key is addressed for update and delete. */
  tokenId: string;
  /** Which key-encryption secret sealed this row. */
  kekId: string;
  nonce: string;
  ciphertext: string;
  tag: string;
  caps: SystemKeyCaps;
  createdAt: number;
  /** When the value was last replaced; null = never rotated. */
  rotatedAt: number | null;
};

export type Kek = { id: string; key: Buffer };

const HKDF_SALT = 'sovereign-agentic-os';
const MIN_SECRET_LENGTH = 32;

/** Derive the key-encryption key (and its public id) from the deployment secret. */
export function deriveKek(secret: string): Kek {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new SystemKeyUnavailableError('not-configured');
  }
  const key = Buffer.from(hkdfSync('sha256', secret, HKDF_SALT, 'agent-system-keys/v1/encrypt', 32));
  // The id comes from a SEPARATE derivation, so storing it next to the ciphertext says nothing about the key.
  const id = Buffer.from(hkdfSync('sha256', secret, HKDF_SALT, 'agent-system-keys/v1/id', 8)).toString('hex');
  return { id, key };
}

const aad = (systemId: string, alias: string) => Buffer.from(`agent-system-key/v1|${systemId}|${alias}`);

/** Encrypt one key value into a storable record. */
export function sealSystemKey(
  input: { systemId: string; alias: string; key: string; caps: SystemKeyCaps; createdAt: number; rotatedAt: number | null },
  kek: Kek,
): SystemKeyRecord {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', kek.key, nonce);
  cipher.setAAD(aad(input.systemId, input.alias));
  const ciphertext = Buffer.concat([cipher.update(input.key, 'utf8'), cipher.final()]);
  return {
    systemId: input.systemId,
    alias: input.alias,
    tokenId: tokenIdOf(input.key),
    kekId: kek.id,
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    caps: input.caps,
    createdAt: input.createdAt,
    rotatedAt: input.rotatedAt,
  };
}

/** Decrypt a record. Throws `unreadable` for a different secret, a tampered row, or a swapped row. */
export function openSystemKey(record: SystemKeyRecord, kek: Kek): string {
  if (record.kekId !== kek.id) throw new SystemKeyUnavailableError('unreadable');
  try {
    const decipher = createDecipheriv('aes-256-gcm', kek.key, Buffer.from(record.nonce, 'base64'));
    decipher.setAAD(aad(record.systemId, record.alias));
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
    const key = Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()]).toString('utf8');
    // The row's own token id must describe the value it holds, or the row was assembled from two.
    if (tokenIdOf(key) !== record.tokenId) throw new Error('token id mismatch');
    return key;
  } catch {
    throw new SystemKeyUnavailableError('unreadable');
  }
}

/** Open a record, reporting failure as data: a wrong secret or an altered row is `{ ok: false }`. */
export function tryOpenSystemKey(record: SystemKeyRecord, kek: Kek): { ok: true; key: string } | { ok: false; error: string } {
  try {
    return { ok: true, key: openSystemKey(record, kek) };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

// ------------------------------------------------------------------ errors -----

export type SystemKeyUnavailableReason = 'missing' | 'unreadable' | 'not-configured' | 'store-unavailable';

const REASON_TEXT: Record<SystemKeyUnavailableReason, string> = {
  missing:
    'This agent system has no model key of its own yet, so it cannot run. Open the system and press Build ' +
    '(Rebuild): that creates its key, with its own budget and limits. The run is not moved onto the shared ' +
    'key, because the system\'s budget and limits would then not apply.',
  unreadable:
    'The stored model key of this agent system cannot be decrypted (the platform\'s key-encryption secret ' +
    'changed, or the stored record was altered). Press Rebuild on the system to issue a new key.',
  'not-configured':
    'The platform has no key-encryption secret (AGENT_KEY_ENCRYPTION_KEY is unset or shorter than 32 characters), ' +
    'so an agent system\'s model key can neither be stored nor read. A platform admin must provide the secret ' +
    '(chart: osUI.agentKeyEncryption) to os-ui and the worker.',
  'store-unavailable':
    'The store that holds agent-system model keys (the agent_runs database) could not be read, so this run ' +
    'cannot get its key. Nothing was run. Try again; if it persists, a platform admin must check the database.',
};

/** Thrown when a system's own key cannot be used. The run stops; no other key is substituted. */
export class SystemKeyUnavailableError extends Error {
  readonly code = 'system_key_unavailable';
  readonly status = 409;
  readonly reason: SystemKeyUnavailableReason;
  constructor(reason: SystemKeyUnavailableReason, detail?: string) {
    super(detail ? `${REASON_TEXT[reason]} (${detail})` : REASON_TEXT[reason]);
    this.name = 'SystemKeyUnavailableError';
    this.reason = reason;
  }
}

// ------------------------------------------------------------------ store ------

export interface SystemKeyStore {
  get(systemId: string): Promise<SystemKeyRecord | null>;
  /** Insert or replace the system's row. */
  put(record: SystemKeyRecord): Promise<void>;
  delete(systemId: string): Promise<void>;
  list(): Promise<SystemKeyRecord[]>;
}

/** The in-process store: a laptop with no database, and the unit tests. */
export function memorySystemKeyStore(): SystemKeyStore {
  const rows = new Map<string, SystemKeyRecord>();
  return {
    async get(systemId) { return rows.get(systemId) ?? null; },
    async put(record) { rows.set(record.systemId, { ...record, caps: { ...record.caps, models: [...record.caps.models] } }); },
    async delete(systemId) { rows.delete(systemId); },
    async list() { return [...rows.values()]; },
  };
}

/** The minimum of `pg.Pool` this module uses — so tests can drive it with a fake. */
export type SqlClient = { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> };

export const AGENT_SYSTEM_KEYS_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS agent_system_keys (
     system_id  TEXT PRIMARY KEY,
     key_alias  TEXT        NOT NULL,
     token_id   TEXT        NOT NULL,
     kek_id     TEXT        NOT NULL,
     nonce      TEXT        NOT NULL,
     ciphertext TEXT        NOT NULL,
     tag        TEXT        NOT NULL,
     caps       JSONB       NOT NULL,
     created_at TIMESTAMPTZ NOT NULL,
     rotated_at TIMESTAMPTZ
   )`,
];

/** Run the idempotent DDL. Safe to call concurrently from several pods. */
export async function migrateSystemKeys(sql: SqlClient): Promise<void> {
  for (const stmt of AGENT_SYSTEM_KEYS_DDL) await sql.query(stmt);
}

const COLS = 'system_id, key_alias, token_id, kek_id, nonce, ciphertext, tag, caps, created_at, rotated_at';

function ms(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return new Date(v).getTime();
  return 0;
}

function toRecord(row: Record<string, unknown>): SystemKeyRecord {
  const caps = typeof row.caps === 'string' ? JSON.parse(row.caps) : row.caps;
  return {
    systemId: String(row.system_id),
    alias: String(row.key_alias),
    tokenId: String(row.token_id),
    kekId: String(row.kek_id),
    nonce: String(row.nonce),
    ciphertext: String(row.ciphertext),
    tag: String(row.tag),
    caps: caps as SystemKeyCaps,
    createdAt: ms(row.created_at),
    rotatedAt: row.rotated_at === null || row.rotated_at === undefined ? null : ms(row.rotated_at),
  };
}

/** The Postgres store over an injected client (a `pg.Pool`, or a fake in tests). */
export function postgresSystemKeyStore(sql: SqlClient): SystemKeyStore {
  return {
    async get(systemId) {
      const res = await sql.query(`SELECT ${COLS} FROM agent_system_keys WHERE system_id = $1`, [systemId]);
      return res.rows[0] ? toRecord(res.rows[0]) : null;
    },
    async put(r) {
      await sql.query(
        `INSERT INTO agent_system_keys (${COLS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, to_timestamp($9::double precision / 1000), to_timestamp($10::double precision / 1000))
         ON CONFLICT (system_id) DO UPDATE SET
           key_alias = EXCLUDED.key_alias, token_id = EXCLUDED.token_id, kek_id = EXCLUDED.kek_id,
           nonce = EXCLUDED.nonce, ciphertext = EXCLUDED.ciphertext, tag = EXCLUDED.tag,
           caps = EXCLUDED.caps, created_at = EXCLUDED.created_at, rotated_at = EXCLUDED.rotated_at`,
        [r.systemId, r.alias, r.tokenId, r.kekId, r.nonce, r.ciphertext, r.tag, JSON.stringify(r.caps), r.createdAt, r.rotatedAt],
      );
    },
    async delete(systemId) {
      await sql.query('DELETE FROM agent_system_keys WHERE system_id = $1', [systemId]);
    },
    async list() {
      const res = await sql.query(`SELECT ${COLS} FROM agent_system_keys ORDER BY system_id`);
      return res.rows.map(toRecord);
    },
  };
}

// ------------------------------------------------------------------ journal ----

/**
 * MAKE-BEFORE-BREAK replacement of a system's key, written down before each gateway step so a
 * process that dies half-way is resumed, never repeated with a second new value:
 *
 *   1. STAGE    the new value, sealed, with the token ids of the key(s) it replaces (`stage`).
 *               Nothing a run reads changes: `resolveSystemKey` never looks here.
 *   2. MOVE     each old key off the alias (`<alias>.retiring.<token prefix>`): its value keeps
 *               working, the alias is free for the new key (LiteLLM requires unique aliases).
 *   3. REGISTER the staged value under the alias (`/key/generate`), unless the gateway has it.
 *   4. SWAP     the staged record into `agent_system_keys`: from here every run uses the new key.
 *   5. DELETE   the old key(s) at the gateway, then `clear` the journal row.
 *
 * Re-running after a crash at any step finds the staged row and continues with the SAME value.
 */
export type StagedSystemKey = {
  record: SystemKeyRecord;
  /** Every old key this replacement retires: token id + the alias it is (or will be) found under. */
  retire: { tokenId: string; alias: string }[];
  stagedAt: number;
};

export interface SystemKeyJournal {
  staged(systemId: string): Promise<StagedSystemKey | null>;
  stage(entry: StagedSystemKey): Promise<void>;
  clear(systemId: string): Promise<void>;
  /** Has the one-time migration of pre-random keys completed in this deployment? */
  migrationDone(name: string): Promise<boolean>;
  markMigrationDone(name: string, at: number): Promise<void>;
}

/** The in-process journal: a laptop with no database, and the unit tests. */
export function memorySystemKeyJournal(): SystemKeyJournal {
  const rows = new Map<string, StagedSystemKey>();
  const done = new Set<string>();
  const copy = (e: StagedSystemKey): StagedSystemKey => ({ ...e, record: { ...e.record, caps: { ...e.record.caps } }, retire: e.retire.map((r) => ({ ...r })) });
  return {
    async staged(systemId) { const e = rows.get(systemId); return e ? copy(e) : null; },
    async stage(entry) { rows.set(entry.record.systemId, copy(entry)); },
    async clear(systemId) { rows.delete(systemId); },
    async migrationDone(name) { return done.has(name); },
    async markMigrationDone(name) { done.add(name); },
  };
}

export const SYSTEM_KEY_JOURNAL_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS agent_system_key_staging (
     system_id  TEXT PRIMARY KEY,
     record     JSONB       NOT NULL,
     retire     JSONB       NOT NULL,
     staged_at  TIMESTAMPTZ NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS agent_system_key_migrations (
     name         TEXT PRIMARY KEY,
     completed_at TIMESTAMPTZ NOT NULL
   )`,
];

/** The Postgres journal over an injected client. The staged record is sealed exactly like a stored one. */
export function postgresSystemKeyJournal(sql: SqlClient): SystemKeyJournal {
  return {
    async staged(systemId) {
      const res = await sql.query('SELECT record, retire, staged_at FROM agent_system_key_staging WHERE system_id = $1', [systemId]);
      const row = res.rows[0];
      if (!row) return null;
      const record = typeof row.record === 'string' ? JSON.parse(row.record) : row.record;
      const retire = typeof row.retire === 'string' ? JSON.parse(row.retire) : row.retire;
      return { record: record as SystemKeyRecord, retire: retire as StagedSystemKey['retire'], stagedAt: ms(row.staged_at) };
    },
    async stage(e) {
      await sql.query(
        `INSERT INTO agent_system_key_staging (system_id, record, retire, staged_at)
         VALUES ($1, $2::jsonb, $3::jsonb, to_timestamp($4::double precision / 1000))
         ON CONFLICT (system_id) DO UPDATE SET record = EXCLUDED.record, retire = EXCLUDED.retire, staged_at = EXCLUDED.staged_at`,
        [e.record.systemId, JSON.stringify(e.record), JSON.stringify(e.retire), e.stagedAt],
      );
    },
    async clear(systemId) {
      await sql.query('DELETE FROM agent_system_key_staging WHERE system_id = $1', [systemId]);
    },
    async migrationDone(name) {
      const res = await sql.query('SELECT 1 FROM agent_system_key_migrations WHERE name = $1', [name]);
      return res.rows.length > 0;
    },
    async markMigrationDone(name, at) {
      await sql.query(
        'INSERT INTO agent_system_key_migrations (name, completed_at) VALUES ($1, to_timestamp($2::double precision / 1000)) ON CONFLICT (name) DO NOTHING',
        [name, at],
      );
    },
  };
}

type Slot = {
  store?: Promise<SystemKeyStore>;
  journal?: Promise<SystemKeyJournal>;
  journalUrl?: string;
  url?: string;
  ephemeralKek?: Kek;
  cache?: Map<string, { value: ResolvedSystemKey; at: number }>;
};
const g = globalThis as unknown as { __osAgentSystemKeys?: Slot };
const slot = (): Slot => (g.__osAgentSystemKeys ??= {});

/** The key store of this process: Postgres when the agent-runs database is configured, else in-memory. */
export function systemKeyStore(): Promise<SystemKeyStore> {
  const s = slot();
  const url = configuredAgentRunsDatabaseUrl();
  if (!s.store || s.url !== url) {
    s.url = url;
    const ready = url
      ? (async (): Promise<SystemKeyStore> => {
          // The process's one agent_runs pool: one primary-key read per model call (cached), one
          // write per build.
          const pool = (await agentRunsPool(url)) as unknown as SqlClient;
          await migrateSystemKeys(pool);
          return postgresSystemKeyStore(pool);
        })()
      : Promise.resolve(memorySystemKeyStore());
    s.store = ready;
    // A failed connect must not be remembered: the next caller retries.
    ready.catch(() => { if (slot().store === ready) delete slot().store; });
  }
  return s.store;
}

/** The process's store behind one stable object — for callers that hold a `SystemKeyStore`, not a promise of one. */
export const durableSystemKeyStore: SystemKeyStore = {
  get: async (systemId) => (await systemKeyStore()).get(systemId),
  put: async (record) => (await systemKeyStore()).put(record),
  delete: async (systemId) => (await systemKeyStore()).delete(systemId),
  list: async () => (await systemKeyStore()).list(),
};

/** The key journal of this process: Postgres when the agent-runs database is configured, else in-memory. */
export function systemKeyJournal(): Promise<SystemKeyJournal> {
  const s = slot();
  const url = configuredAgentRunsDatabaseUrl();
  if (!s.journal || s.journalUrl !== url) {
    s.journalUrl = url;
    const ready = url
      ? (async (): Promise<SystemKeyJournal> => {
          const pool = (await agentRunsPool(url)) as unknown as SqlClient;
          for (const stmt of SYSTEM_KEY_JOURNAL_DDL) await pool.query(stmt);
          return postgresSystemKeyJournal(pool);
        })()
      : Promise.resolve(memorySystemKeyJournal());
    s.journal = ready;
    ready.catch(() => { if (slot().journal === ready) delete slot().journal; });
  }
  return s.journal;
}

/** The process's journal behind one stable object. */
export const durableSystemKeyJournal: SystemKeyJournal = {
  staged: async (id) => (await systemKeyJournal()).staged(id),
  stage: async (e) => (await systemKeyJournal()).stage(e),
  clear: async (id) => (await systemKeyJournal()).clear(id),
  migrationDone: async (n) => (await systemKeyJournal()).migrationDone(n),
  markMigrationDone: async (n, at) => (await systemKeyJournal()).markMigrationDone(n, at),
};

/** Tests only: put a journal (or nothing) in this process's slot. */
export function __setSystemKeyJournalForTests(journal: SystemKeyJournal | null): void {
  const s = slot();
  s.journalUrl = configuredAgentRunsDatabaseUrl();
  s.journal = journal ? Promise.resolve(journal) : undefined;
}

/** Tests only: put a store (or nothing) in this process's slot and drop the read cache. */
export function __setSystemKeyStoreForTests(store: SystemKeyStore | null): void {
  const s = slot();
  s.url = configuredAgentRunsDatabaseUrl();
  s.store = store ? Promise.resolve(store) : undefined;
  s.cache = undefined;
}

/**
 * The key-encryption key of this deployment. With a database configured the secret is REQUIRED:
 * a random stand-in would seal rows no other process (and no later one) could open. With no
 * database the store is this process's memory, so a per-process random key loses nothing.
 */
export function deploymentKek(secret: string = config.agentKeyEncryptionKey): Kek {
  if (secret.length > 0) return deriveKek(secret);
  if (configuredAgentRunsDatabaseUrl().length > 0) throw new SystemKeyUnavailableError('not-configured');
  const s = slot();
  s.ephemeralKek ??= { id: 'ephemeral', key: randomBytes(32) };
  return s.ephemeralKek;
}

// ------------------------------------------------------------------ read -------

/** The name of the reference a run carries for "this call belongs to an agent system". */
export const SYSTEM_KEY_REF_NAME = 'agent-system-key';

/** The reference a run passes down to the model caller — an id, never a value. */
export function systemKeyRef(systemId: string): { name: string; key: string } {
  return { name: SYSTEM_KEY_REF_NAME, key: systemId };
}

export type ResolvedSystemKey = { key: string; tokenId: string; alias: string };

/** How long a decrypted key may be reused in this process before the store is read again. */
const CACHE_MS = 30_000;

/**
 * The system's own key, decrypted for a model call. Throws `SystemKeyUnavailableError` when there
 * is none — the caller must stop, never fall back. `fresh` skips the short in-process cache (used
 * after the gateway rejected the cached key, i.e. it was rotated under a run in flight).
 */
/**
 * The one-time migration that gives every existing system a random, budgeted key
 * (`tabs/agents/lib/build/system-key-migration.ts`). Until os-ui web has completed it, a run of a
 * system with no stored key WAITS for the migration to store one instead of failing — that is
 * what keeps systems nobody rebuilt (and their schedules) running across the upgrade.
 */
export const PRE_RANDOM_KEY_MIGRATION = 'agent-system-keys/v1-random-budgeted';

export type ResolveOptions = {
  fresh?: boolean;
  now?: number;
  /**
   * Wait for the migration when the key is missing. Default: only with a database configured —
   * with none, os-ui is one process and its memory store holds nothing a migration could add.
   */
  awaitMigration?: boolean;
  /** How long a run waits for the migration to store its key (default 3 minutes). */
  migrationWaitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const MIGRATION_WAIT_MS = 180_000;
const MIGRATION_POLL_MS = 2_000;

/** Wait for the migration to store this system's key; null when it completed without one, or the wait ran out. */
async function awaitMigratedRecord(store: SystemKeyStore, systemId: string, opts: ResolveOptions): Promise<SystemKeyRecord | null> {
  if (!(opts.awaitMigration ?? configuredAgentRunsDatabaseUrl().length > 0)) return null;
  const journal = await systemKeyJournal();
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (opts.migrationWaitMs ?? MIGRATION_WAIT_MS);
  while (!(await journal.migrationDone(PRE_RANDOM_KEY_MIGRATION))) {
    if (Date.now() >= deadline) return null;
    await sleep(opts.pollMs ?? MIGRATION_POLL_MS);
    const record = await store.get(systemId);
    if (record) return record;
  }
  // Completed: one last read, in case it stored the key between our two reads.
  return store.get(systemId);
}

export async function resolveSystemKey(systemId: string, opts: ResolveOptions = {}): Promise<ResolvedSystemKey> {
  const now = opts.now ?? Date.now();
  const cache = (slot().cache ??= new Map());
  const hit = cache.get(systemId);
  if (hit && !opts.fresh && now - hit.at < CACHE_MS) return hit.value;
  cache.delete(systemId);
  const kek = deploymentKek();
  let record: SystemKeyRecord | null;
  try {
    const store = await systemKeyStore();
    record = (await store.get(systemId)) ?? (await awaitMigratedRecord(store, systemId, opts));
  } catch (e) {
    throw new SystemKeyUnavailableError('store-unavailable', (e as Error)?.message?.slice(0, 160));
  }
  if (!record) throw new SystemKeyUnavailableError('missing');
  const value: ResolvedSystemKey = { key: openSystemKey(record, kek), tokenId: record.tokenId, alias: record.alias };
  cache.set(systemId, { value, at: now });
  return value;
}

/** Drop this process's cached copy of a system's key (after a rotation, or a gateway rejection). */
export function forgetSystemKey(systemId: string): void {
  slot().cache?.delete(systemId);
}

export type SystemKeyStatus = {
  state: 'ready' | SystemKeyUnavailableReason;
  /** What to tell the owner when the state is not `ready`. */
  message?: string;
  alias?: string;
  createdAt?: number;
  rotatedAt?: number | null;
  caps?: SystemKeyCaps;
};

/** Does this system have a usable key? For the UI and the admin view — carries NO key material. */
export async function systemKeyStatus(systemId: string): Promise<SystemKeyStatus> {
  let record: SystemKeyRecord | null = null;
  try {
    record = await (await systemKeyStore()).get(systemId);
    if (!record) throw new SystemKeyUnavailableError('missing');
    openSystemKey(record, deploymentKek());
    return { state: 'ready', alias: record.alias, createdAt: record.createdAt, rotatedAt: record.rotatedAt, caps: record.caps };
  } catch (e) {
    const err = e instanceof SystemKeyUnavailableError ? e : new SystemKeyUnavailableError('store-unavailable', (e as Error)?.message?.slice(0, 160));
    return {
      state: err.reason,
      message: err.message,
      ...(record ? { alias: record.alias, createdAt: record.createdAt, rotatedAt: record.rotatedAt, caps: record.caps } : {}),
    };
  }
}
