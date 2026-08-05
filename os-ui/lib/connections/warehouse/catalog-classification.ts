/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import { roleAtLeast } from '@/lib/core/session';
import { osMirror } from '@/lib/infra/os-mirror';
import { trace } from '@/lib/infra/agent-governed';
import { getConnectionForUser } from '@/lib/connections/store';
import { getCatalogSnapshot, describeTable, type CatalogSnapshot, type CatalogTableRef, type TableColumn } from '@/lib/connections/warehouse/catalog-snapshot';
import { listDomains } from '@/lib/platform-admin/domains';
import { completeWithEscalation } from '@/lib/assistant/escalate';
import { parseJsonArrayReply } from '@/lib/assistant/json-reply';
import type { AssistantCaller } from '@/lib/assistant/complete';

/**
 * Per-connection CATALOG CLASSIFICATION — the AI-suggested folder taxonomy the Organize
 * stage browses (lakehouse-expose-experience.md, Phase B). It answers "which folder does
 * each table belong in?" using a NAMES-FIRST LLM pass, capped by a column-enriched second
 * pass, and it is HONEST throughout: the AI only ever places tables into the CURRENT
 * taxonomy (it never invents folders), a table it cannot place lands in Unsorted with a
 * plain reason, and a human's manual move is stored as an OVERRIDE that PERMANENTLY wins
 * over any future run.
 *
 * The read is a three-way merge, exactly as the design doc states:
 *   override[fqn] ?? entry[fqn] ?? Unsorted('not-classified')
 * so a table with no AI entry and no human move still resolves to a real folder.
 *
 * Persisted via the SAME registry-mirror pattern the snapshot/exposures stores use
 * (`os-catalog-classifications`): an authoritative in-process Map keyed by connectionId +
 * a best-effort OpenSearch write-through, durable across a pod roll. Mutations are
 * admin-only and audit-traced (`catalog_classified`) through the connection's principal,
 * following exposures.ts trace conventions.
 */

/** Confidence at/above which an AI placement is trusted; below it → Unsorted (design doc). */
export const CONFIDENCE_THRESHOLD = 0.7;

/** Pass-1 batching + concurrency (design doc: 100 tables/call, concurrency 2). */
export const BATCH_SIZE = 100;
export const CONCURRENCY = 2;

/** Pass-2 cap: at most this many lazy DESCRIBEs of sub-threshold tables per run. */
export const PASS2_DESCRIBE_CAP = 50;

export type SeedSource = 'source' | 'os-domains' | 'starter' | 'empty';

export type TaxonomyEntry = { id: string; name: string };

/** The one folder every taxonomy must contain — the honest home for anything unplaced. */
export const UNSORTED = 'unsorted';

/** The starter-set taxonomy (design doc). Unsorted is always last and always present. */
export const STARTER_TAXONOMY: TaxonomyEntry[] = [
  { id: 'financial', name: 'Financial' },
  { id: 'customer', name: 'Customer' },
  { id: 'product', name: 'Product' },
  { id: 'orders', name: 'Orders & Transactions' },
  { id: 'logistics', name: 'Logistics' },
  { id: 'hr', name: 'HR' },
  { id: 'marketing', name: 'Marketing' },
  { id: 'reference', name: 'Reference & Lookup' },
  { id: 'operational', name: 'Operational & Logs' },
  { id: UNSORTED, name: 'Unsorted' },
];

/** One AI placement fact for a `schema.table`. `why` is the classifier's short reason. */
export type ClassificationEntry = {
  category: string;
  confidence: number;
  why: string;
  model: string;
  classifiedAt: string;
};

/** One human move — the override that permanently wins over any AI run. */
export type ClassificationOverride = {
  category: string;
  by: string;
  at: string;
};

export type CatalogClassificationDoc = {
  connectionId: string;
  taxonomy: TaxonomyEntry[];
  seed?: SeedSource;
  entries: Record<string, ClassificationEntry>;
  overrides: Record<string, ClassificationOverride>;
  lastRunAt?: string;
  /** The honest, human-readable summary of the last run (never fabricated). */
  lastRunDetail?: string;
};

function now(): string {
  return new Date().toISOString();
}
function withStatus(err: Error, status: number): Error {
  (err as Error & { status?: number }).status = status;
  return err;
}
const keyOf = (t: CatalogTableRef): string => `${t.schema}.${t.table}`;

const mirror = osMirror({ index: 'os-catalog-classifications' });

type ClsCacheState = { cache: Map<string, CatalogClassificationDoc> | null };
const CLS_STATE_KEY = Symbol.for('soa.catalog-classifications.cache');
function clsState(): ClsCacheState {
  const g = globalThis as unknown as Record<symbol, ClsCacheState | undefined>;
  if (!g[CLS_STATE_KEY]) g[CLS_STATE_KEY] = { cache: null };
  return g[CLS_STATE_KEY]!;
}

async function getCache(): Promise<Map<string, CatalogClassificationDoc>> {
  const s = clsState();
  if (s.cache) return s.cache;
  const map = new Map<string, CatalogClassificationDoc>();
  const docs = await mirror.hydrate(500);
  for (const d of (docs ?? []) as CatalogClassificationDoc[]) map.set(d.connectionId, d);
  s.cache = map;
  return map;
}

function writeThrough(doc: CatalogClassificationDoc): void {
  mirror.writeThrough(doc.connectionId, doc);
}

/** Admin-only gate for every mutating classification operation (fail-closed). */
function assertAdmin(user: CurrentUser): void {
  if (!roleAtLeast(user.role, 'admin')) {
    throw withStatus(new Error('Organizing the catalog with AI requires an Administrator'), 403);
  }
}

// -------------------------------------------------------------- seed taxonomy ---

/** Schema names that carry no meaning for folders — the honest heuristic's generic set. */
const GENERIC_SCHEMAS = new Set([
  'dbo', 'public', 'default', 'raw', 'staging', 'stage', 'tmp', 'temp',
  'information_schema', 'sys', 'pg_catalog', 'main',
]);

/**
 * The honest smart-default heuristic (design doc): pre-select "mirror the source
 * structure" when the snapshot has ≥3 schemas whose names are NOT generic — i.e. the
 * source looks meaningfully organized. Otherwise the starter set is the safer default.
 * Pure + exported so it is unit-tested directly.
 */
export function hasMeaningfulSchemas(schemas: string[]): boolean {
  const meaningful = new Set(
    schemas
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0 && !GENERIC_SCHEMAS.has(s)),
  );
  return meaningful.size >= 3;
}

/** The distinct, sorted schema names present in a snapshot. */
function schemasOf(snapshot: CatalogSnapshot | null): string[] {
  const set = new Set<string>();
  for (const t of snapshot?.tables ?? []) set.add(t.schema);
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** A stable folder id from a display name (lowercase, non-alnum → '-'), never 'unsorted'. */
function slugFolder(name: string): string {
  const s = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s && s !== UNSORTED ? s : `folder-${Math.random().toString(36).slice(2, 6)}`;
}

/** Move/append Unsorted to the end (dropping any dup) — the invariant every taxonomy upholds. */
function withUnsorted(entries: TaxonomyEntry[]): TaxonomyEntry[] {
  const out = entries.filter((e) => e.id !== UNSORTED);
  out.push({ id: UNSORTED, name: 'Unsorted' });
  return out;
}

/**
 * Build the taxonomy a seed choice implies. `source` mirrors the snapshot's schemas;
 * `os-domains` mirrors the tenant's non-archived domains; `starter` is the 10-folder set;
 * `empty` is just Unsorted (the admin adds folders). Unsorted is always appended last.
 */
export function taxonomyForSeed(seed: SeedSource, opts: { schemas?: string[]; domains?: { id: string; name: string }[] } = {}): TaxonomyEntry[] {
  if (seed === 'starter') return STARTER_TAXONOMY.map((e) => ({ ...e }));
  if (seed === 'empty') return [{ id: UNSORTED, name: 'Unsorted' }];
  if (seed === 'source') {
    const seen = new Set<string>();
    const folders: TaxonomyEntry[] = [];
    for (const s of opts.schemas ?? []) {
      const name = s.trim();
      if (!name) continue;
      const id = slugFolder(name);
      if (seen.has(id)) continue;
      seen.add(id);
      folders.push({ id, name });
    }
    return withUnsorted(folders);
  }
  // os-domains
  const seen = new Set<string>();
  const folders: TaxonomyEntry[] = [];
  for (const d of opts.domains ?? []) {
    const id = slugFolder(d.name || d.id);
    if (seen.has(id)) continue;
    seen.add(id);
    folders.push({ id, name: d.name || d.id });
  }
  return withUnsorted(folders);
}

/**
 * The smart-default seed for a connection's current snapshot: `source` when the snapshot
 * has meaningfully-named schemas, else `starter` (design doc). Exported for the route so
 * the chooser can pre-select honestly.
 */
export function smartDefaultSeed(snapshot: CatalogSnapshot | null): SeedSource {
  return hasMeaningfulSchemas(schemasOf(snapshot)) ? 'source' : 'starter';
}

// ---------------------------------------------------------------- read (merge) ---

/** The merged, browse-ready category of one table: override ?? entry ?? Unsorted. */
export type MergedPlacement = {
  category: string;
  /** How the placement was decided — human move, AI entry, or the not-classified floor. */
  source: 'override' | 'ai' | 'unsorted';
  confidence?: number;
  why?: string;
  model?: string;
};

/** Resolve ONE table's placement from a doc — override wins, then AI, then Unsorted. */
export function mergedPlacement(doc: CatalogClassificationDoc, fqn: string): MergedPlacement {
  const ov = doc.overrides[fqn];
  if (ov) return { category: ov.category, source: 'override' };
  const en = doc.entries[fqn];
  if (en) return { category: en.category, source: 'ai', confidence: en.confidence, why: en.why, model: en.model };
  return { category: UNSORTED, source: 'unsorted', why: 'not-classified' };
}

/**
 * The classification the UI reads: the doc plus a merged `placements` map for every table
 * the snapshot currently holds (so a never-classified table still resolves to Unsorted).
 * Same visibility gate as the snapshot route — the caller must SEE the connection.
 */
export type MergedClassification = {
  taxonomy: TaxonomyEntry[];
  seed?: SeedSource;
  placements: Record<string, MergedPlacement>;
  lastRunAt?: string;
  lastRunDetail?: string;
  /** Present when no run has ever happened AND no seed chosen — the chooser's pre-select. */
  suggestedSeed?: SeedSource;
};

export async function getMergedClassification(connId: string, user: CurrentUser): Promise<MergedClassification> {
  await getConnectionForUser(connId, user); // 404s if not visible (same gate as snapshot)
  const map = await getCache();
  const doc = map.get(connId);
  const snapshot = await getCatalogSnapshot(connId, user);
  const tables = snapshot?.tables ?? [];

  if (!doc) {
    // No classification yet — surface the honest smart-default so the chooser pre-selects.
    return {
      taxonomy: [{ id: UNSORTED, name: 'Unsorted' }],
      placements: {},
      suggestedSeed: smartDefaultSeed(snapshot),
    };
  }
  const placements: Record<string, MergedPlacement> = {};
  for (const t of tables) placements[keyOf(t)] = mergedPlacement(doc, keyOf(t));
  return {
    taxonomy: doc.taxonomy,
    seed: doc.seed,
    placements,
    lastRunAt: doc.lastRunAt,
    lastRunDetail: doc.lastRunDetail,
    ...(doc.seed ? {} : { suggestedSeed: smartDefaultSeed(snapshot) }),
  };
}

// ------------------------------------------------------------------- mutations ---

/** Ensure a doc exists (creating an empty one with the given seed if absent). */
function ensureDoc(map: Map<string, CatalogClassificationDoc>, connId: string, taxonomy: TaxonomyEntry[], seed?: SeedSource): CatalogClassificationDoc {
  const existing = map.get(connId);
  if (existing) return existing;
  const doc: CatalogClassificationDoc = { connectionId: connId, taxonomy, seed, entries: {}, overrides: {} };
  map.set(connId, doc);
  return doc;
}

/**
 * SET the taxonomy seed (the "how should folders be organized?" choice). Builds the
 * taxonomy the seed implies and stores it; if a doc already exists this REPLACES the
 * taxonomy but keeps entries/overrides (a re-seed re-folders; the AI will re-place on the
 * next run, human overrides still win). Admin-only, traced.
 */
export async function setSeed(connId: string, user: CurrentUser, seed: SeedSource): Promise<CatalogClassificationDoc> {
  assertAdmin(user);
  const c = await getConnectionForUser(connId, user);
  const snapshot = await getCatalogSnapshot(connId, user);
  const domains = listDomains().filter((d) => !d.archived).map((d) => ({ id: d.id, name: d.name }));
  const taxonomy = taxonomyForSeed(seed, { schemas: schemasOf(snapshot), domains });
  const map = await getCache();
  const doc = ensureDoc(map, connId, taxonomy, seed);
  doc.taxonomy = taxonomy;
  doc.seed = seed;
  writeThrough(doc);
  void trace({
    principal: c.principal,
    tool: 'generate',
    input: { action: 'catalog_taxonomy_seeded', by: user.id, connectionId: connId, seed, folders: taxonomy.length },
    output: { seed },
    decision: 'allow',
  });
  return doc;
}

/** Sanitize an admin-supplied taxonomy edit (add/rename) — Unsorted stays, ids stay valid. */
function sanitizeTaxonomy(input: unknown): TaxonomyEntry[] | null {
  if (!Array.isArray(input)) return null;
  const seen = new Set<string>();
  const out: TaxonomyEntry[] = [];
  for (const e of input) {
    const id = String((e as TaxonomyEntry)?.id ?? '').trim();
    const name = String((e as TaxonomyEntry)?.name ?? '').trim();
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name });
  }
  return withUnsorted(out);
}

/**
 * PATCH the taxonomy (admin add/rename folders). AI entries stay put; any entry pointing
 * at a folder that no longer exists is READ as Unsorted at merge time (the id simply won't
 * be in the taxonomy), so a removed folder degrades honestly without touching entries.
 */
export async function patchTaxonomy(connId: string, user: CurrentUser, taxonomy: unknown): Promise<CatalogClassificationDoc> {
  assertAdmin(user);
  const c = await getConnectionForUser(connId, user);
  const clean = sanitizeTaxonomy(taxonomy);
  if (!clean) throw withStatus(new Error('A taxonomy must be a list of {id,name} folders'), 400);
  const map = await getCache();
  const doc = ensureDoc(map, connId, clean, undefined);
  doc.taxonomy = clean;
  writeThrough(doc);
  void trace({
    principal: c.principal,
    tool: 'generate',
    input: { action: 'catalog_taxonomy_edited', by: user.id, connectionId: connId, folders: clean.length },
    output: { folders: clean.length },
    decision: 'allow',
  });
  return doc;
}

/**
 * OVERRIDE one table's folder (a human move). Stored permanently; it wins over every
 * future AI run. Moving to a folder that isn't in the taxonomy is rejected (no inventing).
 */
export async function overridePlacement(connId: string, user: CurrentUser, fqn: string, category: string): Promise<CatalogClassificationDoc> {
  assertAdmin(user);
  const c = await getConnectionForUser(connId, user);
  const map = await getCache();
  const doc = map.get(connId);
  if (!doc) throw withStatus(new Error('Organize the catalog first'), 400);
  const cat = category.trim();
  if (!doc.taxonomy.some((t) => t.id === cat)) {
    throw withStatus(new Error(`Unknown folder '${cat}'`), 400);
  }
  doc.overrides[fqn] = { category: cat, by: user.id, at: now() };
  writeThrough(doc);
  void trace({
    principal: c.principal,
    tool: 'generate',
    input: { action: 'catalog_table_moved', by: user.id, connectionId: connId, fqn, category: cat },
    output: { fqn, category: cat },
    decision: 'allow',
  });
  return doc;
}

// ------------------------------------------------------------ the run (engine) ---

/** A run's honest tally, surfaced in `lastRunDetail`. */
export type RunTally = {
  classified: number;
  unsorted: number;
  batches: number;
  escalatedBatches: number;
  hallucinatedDropped: number;
  enrichedPass2: number;
  /** Set when a cost cap / gateway failure stopped the run early — honest, not silent. */
  stoppedEarly?: string;
};

/** Injected engine dependencies (tests pin a fake completer + describe seam). */
export type RunDeps = {
  caller?: AssistantCaller;
  /** Overrides the lazy DESCRIBE (Pass 2). Defaults to the governed describeTable. */
  describe?: (schema: string, table: string) => Promise<TableColumn[]>;
  standardModel?: string;
  reasoningModel?: string;
};

/** Split a list into fixed-size chunks (Pass-1 batching). */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The verbatim system prompt for Pass 1 (names only). Grounded in the CURRENT taxonomy. */
function pass1System(taxonomy: TaxonomyEntry[]): string {
  const folders = taxonomy.map((t) => `- ${t.id}: ${t.name}`).join('\n');
  return [
    'You organize database tables into a FIXED set of folders for a data catalog.',
    'You are given ONLY the schema.table names — no columns. Judge from the names alone.',
    '',
    'The folders you may use (use the id, never invent a new folder):',
    folders,
    '',
    'Rules:',
    `- Reply with ONLY a JSON array, one object per input table: {"table":"schema.table","category":"<folder id>","confidence":<0..1>,"why":"<=12 words"}.`,
    '- Use ONLY a folder id from the list above. If none fits, use "unsorted".',
    '- confidence is your honest 0..1 certainty from the name alone.',
    '- Include every input table exactly once. Do not add tables that were not given.',
    '- No prose, no markdown fences — just the JSON array.',
  ].join('\n');
}

/** The verbatim system prompt for Pass 2 (column-enriched, low-confidence tables). */
function pass2System(taxonomy: TaxonomyEntry[]): string {
  const folders = taxonomy.map((t) => `- ${t.id}: ${t.name}`).join('\n');
  return [
    'You re-classify database tables that were hard to place by name alone.',
    'For each table you now also have its column names (and any column comments).',
    'Use the columns as evidence to pick the best folder.',
    '',
    'The folders you may use (use the id, never invent a new folder):',
    folders,
    '',
    'Rules:',
    `- Reply with ONLY a JSON array, one object per input table: {"table":"schema.table","category":"<folder id>","confidence":<0..1>,"why":"<=12 words"}.`,
    '- Use ONLY a folder id from the list above. If none fits, use "unsorted".',
    '- Include every input table exactly once. Do not add tables that were not given.',
    '- No prose, no markdown fences — just the JSON array.',
  ].join('\n');
}

type RawItem = { table: string; category: string; confidence: number; why: string };

/**
 * Validate + normalize one LLM batch against the tables it was ASKED about and the current
 * taxonomy. The hallucination guard drops any table key that wasn't in the request (counted
 * in `hallucinatedDropped`); an unknown category id degrades to Unsorted (never invented);
 * a missing/out-of-range confidence rejects that element. Returns the accepted items keyed
 * by fqn, plus the tables the batch simply left out (for the remainder retry).
 */
export function validateBatch(
  raw: unknown[] | null,
  askedFqns: string[],
  taxonomyIds: Set<string>,
): { accepted: Map<string, RawItem>; missing: string[]; hallucinatedDropped: number } {
  const asked = new Set(askedFqns);
  const accepted = new Map<string, RawItem>();
  let hallucinatedDropped = 0;
  for (const el of raw ?? []) {
    if (!el || typeof el !== 'object') continue;
    const o = el as Record<string, unknown>;
    const table = String(o.table ?? '').trim();
    if (!table || !asked.has(table)) { hallucinatedDropped++; continue; } // hallucination guard
    const conf = typeof o.confidence === 'number' ? o.confidence : NaN;
    if (!Number.isFinite(conf) || conf < 0 || conf > 1) continue; // reject bad-confidence element
    const catRaw = String(o.category ?? '').trim();
    const category = taxonomyIds.has(catRaw) ? catRaw : UNSORTED; // unknown id → Unsorted
    const why = String(o.why ?? '').trim().slice(0, 160);
    if (!accepted.has(table)) accepted.set(table, { table, category, confidence: conf, why });
  }
  const missing = askedFqns.filter((f) => !accepted.has(f));
  return { accepted, missing, hallucinatedDropped };
}

/** Run a promise-returning mapper over items with a fixed concurrency, preserving order. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

type BatchOutcome = {
  accepted: Map<string, RawItem>;
  missing: string[];
  hallucinatedDropped: number;
  escalated: boolean;
  model: string;
  failed?: string; // set when the batch call threw (cost cap / gateway) — honest early stop
};

/** Ask the model to classify ONE batch of names, validated + escalated. */
async function runBatch(
  fqns: string[],
  taxonomy: TaxonomyEntry[],
  taxonomyIds: Set<string>,
  user: CurrentUser,
  deps: RunDeps,
): Promise<BatchOutcome> {
  const system = pass1System(taxonomy);
  const userMsg = `Classify these ${fqns.length} tables:\n${fqns.join('\n')}`;
  try {
    const res = await completeWithEscalation(
      [
        { role: 'system', content: system },
        { role: 'user', content: userMsg },
      ],
      {
        user: { id: user.id, domains: user.domains },
        caller: deps.caller,
        standardModel: deps.standardModel,
        reasoningModel: deps.reasoningModel,
        // The quality gate: a usable batch parses to an array with at least one asked table.
        validate: (content) => {
          const parsed = parseJsonArrayReply(content);
          const v = validateBatch(parsed, fqns, taxonomyIds);
          return v.accepted.size > 0;
        },
      },
    );
    const parsed = parseJsonArrayReply(res.content);
    const v = validateBatch(parsed, fqns, taxonomyIds);
    return { ...v, escalated: res.escalated, model: res.model };
  } catch (e) {
    // Gateway unreachable / cost cap (402/503) → honest early stop, not a silent success.
    return { accepted: new Map(), missing: fqns, hallucinatedDropped: 0, escalated: false, model: '', failed: (e as Error).message };
  }
}

/**
 * RUN the classifier over a set of tables. `mode:'run'` (re)classifies the given set;
 * `mode:'run-new'` classifies only tables with no entry yet (prevDiff.added ∪ missing).
 * OVERRIDES are never touched. Returns the updated doc.
 *
 * Pass 1: names only, batched (100), concurrency 2, standard-first-escalated per batch.
 * A table the batches leave out is retried once in a remainder batch, then → Unsorted
 * `not-classified`. Pass 2: up to 50 lazy DESCRIBEs of sub-threshold tables → one
 * column-enriched enrichment call. A cost-cap / gateway failure stops the run and is
 * reported honestly in `lastRunDetail` (never a fabricated tally).
 */
export async function runClassification(
  connId: string,
  user: CurrentUser,
  mode: 'run' | 'run-new',
  deps: RunDeps = {},
): Promise<{ doc: CatalogClassificationDoc; tally: RunTally }> {
  assertAdmin(user);
  const c = await getConnectionForUser(connId, user);
  const snapshot = await getCatalogSnapshot(connId, user);
  const tables = snapshot?.tables ?? [];
  const map = await getCache();
  const doc = map.get(connId);
  if (!doc) throw withStatus(new Error('Choose how folders are organized first'), 400);

  const taxonomy = doc.taxonomy;
  const taxonomyIds = new Set(taxonomy.map((t) => t.id));

  // WHICH tables this run classifies. 'run' = all snapshot tables that aren't overridden
  // (a human move is final). 'run-new' = only those with no AI entry yet (added ∪ missing).
  const overridden = new Set(Object.keys(doc.overrides));
  const targets = tables
    .map(keyOf)
    .filter((k) => !overridden.has(k))
    .filter((k) => (mode === 'run-new' ? !doc.entries[k] : true));

  const tally: RunTally = { classified: 0, unsorted: 0, batches: 0, escalatedBatches: 0, hallucinatedDropped: 0, enrichedPass2: 0 };

  if (targets.length === 0) {
    doc.lastRunAt = now();
    doc.lastRunDetail = mode === 'run-new' ? 'Nothing new to organize — every table already has a folder.' : 'No tables to organize.';
    writeThrough(doc);
    return { doc, tally };
  }

  // ---- Pass 1: names only, batched + concurrency-limited ----
  const batches = chunk(targets, BATCH_SIZE);
  const outcomes = await mapWithConcurrency(batches, CONCURRENCY, (b) => runBatch(b, taxonomy, taxonomyIds, user, deps));

  const at = now();
  const model = outcomes.find((o) => o.model)?.model ?? '';
  let stoppedEarly: string | undefined;
  const stillMissing: string[] = [];

  for (const o of outcomes) {
    tally.batches++;
    if (o.escalated) tally.escalatedBatches++;
    tally.hallucinatedDropped += o.hallucinatedDropped;
    if (o.failed && !stoppedEarly) stoppedEarly = o.failed;
    for (const [fqn, item] of o.accepted) {
      doc.entries[fqn] = { category: item.category, confidence: item.confidence, why: item.why, model: o.model || model, classifiedAt: at };
    }
    for (const m of o.missing) stillMissing.push(m);
  }

  // ---- Remainder retry: tables no batch answered → one more batch, then Unsorted ----
  if (stillMissing.length > 0 && !stoppedEarly) {
    const retry = await runBatch(stillMissing, taxonomy, taxonomyIds, user, deps);
    tally.batches++;
    if (retry.escalated) tally.escalatedBatches++;
    tally.hallucinatedDropped += retry.hallucinatedDropped;
    if (retry.failed && !stoppedEarly) stoppedEarly = retry.failed;
    for (const [fqn, item] of retry.accepted) {
      doc.entries[fqn] = { category: item.category, confidence: item.confidence, why: item.why, model: retry.model || model, classifiedAt: at };
    }
    for (const m of retry.missing) {
      doc.entries[m] = { category: UNSORTED, confidence: 0, why: 'not-classified', model: retry.model || model, classifiedAt: at };
    }
  } else if (stillMissing.length > 0) {
    // The run stopped early (cost/gateway) — leftover tables land in Unsorted honestly.
    for (const m of stillMissing) {
      doc.entries[m] = { category: UNSORTED, confidence: 0, why: 'not-classified', model, classifiedAt: at };
    }
  }

  // ---- Pass 2: column-enriched retry of sub-threshold tables (capped, best-effort) ----
  if (!stoppedEarly) {
    const subThreshold = targets
      .filter((k) => {
        const e = doc.entries[k];
        return e && e.confidence < CONFIDENCE_THRESHOLD;
      })
      .slice(0, PASS2_DESCRIBE_CAP);
    if (subThreshold.length > 0) {
      const describe = deps.describe ?? ((schema: string, table: string) => describeTable(connId, user, { schema, table }));
      const lines: string[] = [];
      for (const fqn of subThreshold) {
        const [schema, table] = fqn.split('.');
        try {
          const cols = await describe(schema, table);
          const colText = cols.map((col) => (col.comment ? `${col.name}(${col.comment})` : col.name)).join(', ');
          lines.push(`${fqn} :: ${colText}`);
          tally.enrichedPass2++;
        } catch {
          // A table we couldn't DESCRIBE keeps its Pass-1 placement — honest, not fatal.
        }
      }
      if (lines.length > 0) {
        const enrich = await runEnrichment(lines, subThreshold, taxonomy, taxonomyIds, user, deps);
        for (const [fqn, item] of enrich) {
          doc.entries[fqn] = { category: item.category, confidence: item.confidence, why: item.why, model: model, classifiedAt: at };
        }
      }
    }
  }

  // ---- Tally + honest run detail ----
  for (const k of targets) {
    const e = doc.entries[k];
    if (e && e.category !== UNSORTED) tally.classified++;
    else tally.unsorted++;
  }
  if (stoppedEarly) tally.stoppedEarly = stoppedEarly;

  doc.lastRunAt = at;
  doc.lastRunDetail = describeRun(tally, targets.length);
  writeThrough(doc);

  void trace({
    principal: c.principal,
    tool: 'generate',
    input: { action: 'catalog_classified', by: user.id, connectionId: connId, mode, targets: targets.length },
    output: { classified: tally.classified, unsorted: tally.unsorted, batches: tally.batches, escalatedBatches: tally.escalatedBatches, stoppedEarly: tally.stoppedEarly ?? null },
    decision: 'allow',
  });

  return { doc, tally };
}

/** One column-enriched enrichment call (Pass 2). Same validator + escalation as a batch. */
async function runEnrichment(
  lines: string[],
  fqns: string[],
  taxonomy: TaxonomyEntry[],
  taxonomyIds: Set<string>,
  user: CurrentUser,
  deps: RunDeps,
): Promise<Map<string, RawItem>> {
  const system = pass2System(taxonomy);
  const userMsg = `Re-classify these ${fqns.length} tables using their columns:\n${lines.join('\n')}`;
  try {
    const res = await completeWithEscalation(
      [
        { role: 'system', content: system },
        { role: 'user', content: userMsg },
      ],
      {
        user: { id: user.id, domains: user.domains },
        caller: deps.caller,
        standardModel: deps.standardModel,
        reasoningModel: deps.reasoningModel,
        validate: (content) => validateBatch(parseJsonArrayReply(content), fqns, taxonomyIds).accepted.size > 0,
      },
    );
    return validateBatch(parseJsonArrayReply(res.content), fqns, taxonomyIds).accepted;
  } catch {
    return new Map(); // enrichment is best-effort; a failure leaves Pass-1 placements intact
  }
}

/**
 * The honest, human-readable run summary (design doc's example: "132 classified, 12
 * unsorted, 3 batches escalated, cost-capped after batch 7"). Never fabricated.
 */
export function describeRun(tally: RunTally, targetCount: number): string {
  const parts: string[] = [];
  parts.push(`${tally.classified} classified`);
  parts.push(`${tally.unsorted} unsorted`);
  if (tally.escalatedBatches > 0) parts.push(`${tally.escalatedBatches} of ${tally.batches} batch${tally.batches === 1 ? '' : 'es'} escalated`);
  if (tally.enrichedPass2 > 0) parts.push(`${tally.enrichedPass2} column-enriched`);
  if (tally.hallucinatedDropped > 0) parts.push(`${tally.hallucinatedDropped} hallucinated placement${tally.hallucinatedDropped === 1 ? '' : 's'} dropped`);
  if (tally.stoppedEarly) {
    const done = tally.classified + tally.unsorted;
    parts.push(`stopped early after ${done} of ${targetCount} (${tally.stoppedEarly})`);
  }
  return parts.join(', ') + '.';
}

/** Test seam — forget the in-process cache (mirrors the store's __reset idiom). */
export function __resetCatalogClassifications(): void {
  clsState().cache = null;
  mirror.__reset();
}
