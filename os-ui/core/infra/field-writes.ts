/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    A store write sends only what this process changed — never its stale copy of the rest
 * USER STORY: As a user I edit my work in the web app while an agent, running in the worker pod,
 *             changes the same record (documents my dataset, archives my workflow, tests my
 *             connection). When both are done — and after any restart — my edit and the agent's
 *             change are both there. Neither process puts back its old copy of the other's fields.
 * ARCHITECTURE:
 *   - THE PROBLEM: each store keeps an in-process Map, loaded at boot, plus a best-effort
 *     OpenSearch mirror (`os-mirror.ts`). `os-ui` and `os-ui-worker` each hold their own Map. A
 *     write that PUTs the WHOLE record from one process overwrites every field the other process
 *     changed since this one loaded it — and a restart then hydrates the overwritten version.
 *   - THE MECHANISM (one, shared by every store): a store remembers, per record, a fingerprint of
 *     each top-level field AS THE MIRROR HAD IT when this process last read or wrote it
 *     (`SeenFields`, kept in the store's own state). A write then compares the record with that
 *     memory and sends ONLY the fields that differ, as a partial `_update` (`patchThrough`).
 *     Fields this process did not touch are not sent, so whatever another process wrote there
 *     stays. No per-operation field lists to keep in sync with the code.
 *   - REFRESH-BEFORE-WRITE, for a record whose meaning lives in ONE big field (a dataset's yaml):
 *     `readNewest` re-reads the record from the mirror, and `mergeChanged` takes this process's
 *     value only for the parts it changed and the newest copy's value for everything else.
 *   - DELETES STAY DELETED: in the run worker a write is never an upsert — a record another
 *     process deleted answers 404 and is not re-created. In os-ui (the process that creates and
 *     deletes records) the whole record is the upsert, as before, so an edit is never lost to a
 *     write that reached the mirror late.
 *   - Granularity is a TOP-LEVEL field: two processes changing the SAME field still race (the
 *     later write wins). That is a real conflict, not a lost update of an untouched field.
 *   - Kept free of `server-only`/Next imports and of `node:` modules (some stores reach the
 *     client bundle), so it is unit-testable directly.
 */
import type { OsMirror, MirrorPatch } from '@core/infra/os-mirror';
import { isRunWorkerProcess } from '@core/kernel/process-role';

type Doc = Record<string, unknown>;

/** Per record id: per top-level field, the fingerprint of the value the mirror holds as far as
 *  this process knows. A field missing from the inner map was absent. */
export type SeenFields = Map<string, Map<string, string>>;

export function newSeenFields(): SeenFields {
  return new Map();
}

/** A collision-resistant fingerprint of a JSON value (two independent 53-bit hashes). */
export function fingerprint(value: unknown): string {
  if (value === undefined) return '-';
  const s = JSON.stringify(value) ?? '-';
  return `${hash53(s, 0x9e3779b1).toString(36)}.${hash53(s, 0x85ebca6b).toString(36)}.${s.length}`;
}

/** cyrb53 — a fast, well-distributed 53-bit string hash (public domain). */
function hash53(str: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function fingerprints(doc: Doc): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(doc)) if (v !== undefined) out.set(k, fingerprint(v));
  return out;
}

/** Remember `doc` as what the mirror holds for `id` (after a hydrate, a refresh or a write). */
export function noteSeen(seen: SeenFields, id: string, doc: Doc): void {
  seen.set(id, fingerprints(doc));
}

export function forgetSeen(seen: SeenFields, id: string): void {
  seen.delete(id);
}

/** The top-level fields of `doc` that differ from what this process last saw for `id`. With no
 *  memory of the record every present field is sent (and nothing is removed). */
export function changedPatch(seen: SeenFields, id: string, doc: Doc): MirrorPatch {
  const before = seen.get(id);
  const set: Doc = {};
  const unset: string[] = [];
  for (const [k, v] of Object.entries(doc)) {
    if (v === undefined) continue;
    if (!before || before.get(k) !== fingerprint(v)) set[k] = v;
  }
  if (before) for (const k of before.keys()) if (doc[k] === undefined) unset.push(k);
  return { set, unset };
}

/** Store a NEW record whole (nobody else can have changed a record that did not exist). */
export function writeNew(mirror: OsMirror, seen: SeenFields, id: string, doc: Doc): void {
  mirror.writeThrough(id, doc);
  noteSeen(seen, id, doc);
}

/**
 * Store a change to an EXISTING record: only the fields that differ from what this process last
 * saw. Nothing changed → nothing is sent. In the run worker the write never creates the record
 * (a record deleted elsewhere stays deleted); elsewhere the whole record is the upsert.
 */
export function writeChanged(mirror: OsMirror, seen: SeenFields, id: string, doc: Doc): void {
  const patch = changedPatch(seen, id, doc);
  if (Object.keys(patch.set).length === 0 && patch.unset.length === 0) return;
  mirror.patchThrough(id, patch, isRunWorkerProcess() ? undefined : { upsert: doc });
  noteSeen(seen, id, doc);
}

/** One in-order queue per record, so two writes of the same record never land out of order. */
const queues = new Map<string, Promise<unknown>>();
function inOrder<T>(key: string, run: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).then(run, run);
  const settled = next.catch(() => undefined);
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return next;
}

/**
 * {@link writeChanged} for a record whose meaning lives in ONE big field (a dataset's `yaml`).
 * When that field changed here, the newest copy is read first and `merge(newestValue)` is sent
 * for it instead: the store merges by the field's own parts, keeping the newest value of every
 * part this process did not change. The other changed fields are sent as they are. If, in the run
 * worker, the record turns out to be gone, nothing is written and `onAbsent` runs. Writes of one
 * record go out in order. Resolves with the value sent for `field` (undefined → not sent).
 */
export function writeChangedMerging(
  mirror: OsMirror,
  seen: SeenFields,
  id: string,
  doc: Doc,
  field: string,
  merge: (newest: unknown) => unknown,
  onAbsent: () => void,
): Promise<unknown> {
  const patch = changedPatch(seen, id, doc);
  if (Object.keys(patch.set).length === 0 && patch.unset.length === 0) return Promise.resolve(undefined);
  noteSeen(seen, id, doc); // the next write of this record diffs from here, not from the older copy
  return inOrder(`${mirror.index}/${id}`, async () => {
    if (field in patch.set) {
      const newest = await mirror.read(id);
      if (newest.state === 'absent' && isRunWorkerProcess()) {
        forgetSeen(seen, id);
        onAbsent();
        return undefined;
      }
      if (newest.state === 'found') patch.set[field] = merge((newest.doc as Doc)[field]);
      seen.get(id)?.set(field, fingerprint(patch.set[field]));
    }
    mirror.patchThrough(id, patch, isRunWorkerProcess() ? undefined : { upsert: { ...doc, ...patch.set } });
    return patch.set[field];
  });
}

/**
 * The refresh-before-write for a record whose single source is a `yaml` string (datasets, files):
 * {@link writeChangedMerging} on `yaml`, merged by the PARSED document's top-level fields against
 * the yaml this process last saw (`seenYaml`, kept by the store). When the merge produced a yaml
 * this process did not have, its copy is updated too (`onMerged`), unless it changed again
 * meanwhile — the next write merges that. An unparseable side falls back to this process's yaml.
 */
export function writeMergedYaml<R extends { id: string; yaml: string }>(
  mirror: OsMirror,
  seen: SeenFields,
  seenYaml: Map<string, string>,
  rec: R,
  yamlCodec: { parse(yaml: string): object; serialize(doc: object): string },
  on: { absent(): void; merged(yaml: string): void },
): void {
  const sent = rec.yaml;
  const baseYaml = seenYaml.get(rec.id);
  const merge = (newest: unknown): unknown => {
    if (typeof newest !== 'string' || baseYaml === undefined || newest === baseYaml) return sent;
    try {
      const base = new Map(Object.entries(yamlCodec.parse(baseYaml)).map(([k, v]) => [k, fingerprint(v)]));
      return yamlCodec.serialize(mergeChanged(base, yamlCodec.parse(sent) as Doc, yamlCodec.parse(newest) as Doc));
    } catch {
      return sent;
    }
  };
  const absent = () => {
    seenYaml.delete(rec.id);
    on.absent();
  };
  void writeChangedMerging(mirror, seen, rec.id, rec as unknown as Doc, 'yaml', merge, absent).then((yaml) => {
    if (typeof yaml !== 'string') return;
    seenYaml.set(rec.id, yaml);
    if (yaml !== sent && rec.yaml === sent) on.merged(yaml);
  });
}

/** Resolves once every write of this record queued here has been sent — for a store that must
 *  AWAIT its own delete (`deleteConfirmed`) and so cannot use {@link writeDeleted}. */
export function writesSettled(mirror: OsMirror, id: string): Promise<void> {
  return (queues.get(`${mirror.index}/${id}`) ?? Promise.resolve()).then(() => undefined);
}

/** Delete a record from the mirror — AFTER any write of it still queued here, so a write sent
 *  before the delete can never land after it (and re-create the record). */
export function writeDeleted(mirror: OsMirror, seen: SeenFields, id: string): void {
  forgetSeen(seen, id);
  const key = `${mirror.index}/${id}`;
  if (!queues.has(key)) mirror.deleteThrough(id);
  else void inOrder(key, async () => mirror.deleteThrough(id));
}

/** Re-read one record from the mirror ('found' also refreshes this process's memory of it). */
export async function readNewest(
  mirror: OsMirror,
  seen: SeenFields,
  id: string,
): Promise<{ state: 'found'; doc: Doc } | { state: 'absent' } | { state: 'unreachable' }> {
  const r = await mirror.read(id);
  if (r.state !== 'found') return r;
  const doc = r.doc as Doc;
  noteSeen(seen, id, doc);
  return { state: 'found', doc };
}

/**
 * Refresh-before-write: re-read ONE record so the operation that follows starts from the newest
 * copy. 'found' → `on.put(doc)` (and this process now remembers that copy). 'absent' → in the run
 * worker the record was deleted elsewhere, so `on.drop()` removes it here too and nothing writes
 * it back; in os-ui an absent doc may simply be a create still queued for the mirror, so the
 * in-process copy is kept. 'unreachable' → nothing changes (offline degrade).
 */
export async function refreshRecord(
  mirror: OsMirror,
  seen: SeenFields,
  id: string,
  on: { put(doc: Doc): void; drop(): void },
): Promise<'found' | 'absent' | 'unreachable'> {
  const r = await readNewest(mirror, seen, id);
  if (r.state === 'found') {
    if (r.doc.id !== undefined && r.doc.id !== id) return 'unreachable'; // not the doc we asked for
    on.put(r.doc);
  } else if (r.state === 'absent' && isRunWorkerProcess()) {
    on.drop();
    forgetSeen(seen, id);
  }
  return r.state;
}

/**
 * Three-way merge of top-level fields: `ours` wins for every field this process changed since
 * `base` (fingerprints of what it started from); `newest` wins for every other field. A field
 * this process removed stays removed.
 */
export function mergeChanged(base: Map<string, string> | undefined, ours: Doc, newest: Doc): Doc {
  if (!base) return { ...ours };
  const out: Doc = { ...newest };
  const keys = new Set([...Object.keys(ours), ...base.keys()]);
  for (const k of keys) {
    const mine = ours[k];
    if (fingerprint(mine) === (base.get(k) ?? '-')) continue; // untouched here → keep newest
    if (mine === undefined) delete out[k];
    else out[k] = mine;
  }
  return out;
}
