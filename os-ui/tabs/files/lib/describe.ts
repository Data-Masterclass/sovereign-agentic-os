/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Automatic description + tags — run one generation for a file, and the admin
 *             backfill over the files that have text but no description or tags
 * USER STORY: As an uploader I want the description and tags to appear a moment after my upload
 *             without the upload waiting for them; when the model cannot do it I want my file
 *             stored exactly as it is with one specific reason and a way to try again. As an
 *             admin I want to see how many existing files would be described and roughly what
 *             that costs before anything is written, then run it in batches billed to me.
 * ARCHITECTURE:
 *   - THE EXTRACTION'S SHAPE, REUSED. One in-flight run per file per process, a bounded wait for
 *     the caller (`waitMs`) while the same promise finishes in this process, and
 *     pending / failed-with-reason / done recorded on the file (`store.markAutoDocsPending`,
 *     `recordAutoDocsFailure`, `applyGeneratedDocs`). A `pending` nobody is running any more is
 *     turned into an honest `interrupted` by {@link settleStaleAutoDocs}.
 *   - NEVER FOR A DECISION. `auto-docs.autoDocsEligibility` is consulted before the text is read
 *     for the prompt and AGAIN at the write (in the store): a restricted file or an owner's
 *     opt-out never reaches the model, and a result that arrives after the owner restricted the
 *     file is dropped.
 *   - AS THE ACTING USER, OR NOT AT ALL. Every run names the user it is for; the injected
 *     `complete` bills that user through the gateway. There is no platform fallback: a door with
 *     no acting user does not call this.
 *   - NOTHING INVENTED, UNDER ANY SETTING. Nothing here consults `OS_OFFLINE_MOCK`, because there
 *     is no stand-in branch to gate. A model role that points at the mock model is refused
 *     (`not-configured`): a canned reply is not a description of this file.
 *   - THE BACKFILL IS STATELESS ON PURPOSE. What still needs describing is read from the files
 *     themselves, so a described file simply stops being a candidate: running twice writes
 *     nothing twice, and a run that stopped is continued by calling it again. The cursor only
 *     keeps one call sequence from retrying a file that just failed.
 *   - IN THE OWNER'S LANGUAGE. The description and tags are written in the file owner's UI
 *     language (`deps.locale`, read fresh); English leaves the prompt byte-for-byte unchanged.
 *   - Pure + injected ({@link DescribeDeps}); `pipeline-server.ts` wires the live model.
 */
import type { AutoDocsCode, FileAsset } from '@tabs/files/lib/asset-schema';
import {
  AUTO_DOCS_LIMITS,
  autoDocsEligibility,
  buildDescribeMessages,
  descriptionOwner,
  estimateInputTokens,
  generationPlan,
  parseDocsReply,
  repairMessages,
  type DescribeMessage,
} from '@tabs/files/lib/auto-docs';
import {
  applyGeneratedDocs,
  autoDocsSubject,
  listAllForAutoDocs,
  markAutoDocsPending,
  recordAutoDocsFailure,
  recordAutoDocsSkipped,
  tagVocabulary,
} from '@tabs/files/lib/store';
import { codedError } from '@core/kernel/server-message';

export type DescribeCallContext = { userId: string; domain: string; model: string };

export type DescribeDeps = {
  /** The admin switch. Off ⇒ no model call. */
  enabled: () => boolean | Promise<boolean>;
  /** The model alias of the cheap standard role. */
  model: () => string;
  /** One model call, billed to `ctx.userId` with the file's domain. Resolves with the reply text; throws when there is none. */
  complete: (messages: DescribeMessage[], ctx: DescribeCallContext) => Promise<string>;
  /**
   * The language of the person a description is for (i18n option A) — read FRESH, because the
   * generation may run in the worker or in the background. Absent ⇒ English (the prompt unchanged).
   */
  locale?: (userId: string) => Promise<string>;
  /** Refresh the file's index rows so search matches the new description and tags. */
  index: (asset: FileAsset, text: string, actingUserId: string) => Promise<void>;
};

export type DescribeResult =
  | { state: 'done'; description: boolean; tags: string[] }
  | { state: 'pending' }
  | { state: 'failed'; code: AutoDocsCode; reason: string }
  | { state: 'skipped'; code: 'restricted' | 'opt-out' | 'no-text' | 'nothing-to-write' | 'disabled' | 'gone' | 'discarded'; why: string };

const FLIGHTS_KEY = Symbol.for('soa.files.describe.flights');
function flights(): Map<string, Promise<DescribeResult>> {
  const g = globalThis as unknown as Record<symbol, Map<string, Promise<DescribeResult>> | undefined>;
  if (!g[FLIGHTS_KEY]) g[FLIGHTS_KEY] = new Map();
  return g[FLIGHTS_KEY]!;
}

/** Turn whatever the model call threw into a typed code and ONE sentence a user can act on. */
export function classifyModelError(e: unknown): { code: AutoDocsCode; reason: string } {
  const err = (e ?? {}) as { code?: unknown; status?: unknown; name?: unknown; message?: unknown };
  const message = typeof err.message === 'string' ? err.message : '';
  const status = typeof err.status === 'number' ? err.status : Number(/^LiteLLM (\d{3})/.exec(message)?.[1] ?? NaN);
  if (err.code === 'no_run_credential') {
    return { code: 'not-configured', reason: 'No description was written: no model key is configured for this workspace.' };
  }
  if (err.code === 'budget_exceeded' || status === 402 || /budget/i.test(message)) {
    return { code: 'budget', reason: 'No description was written: the model budget is used up. Try again when it resets or an admin raises it.' };
  }
  if (Number.isFinite(status) && status >= 400 && status < 500) {
    return { code: 'model-rejected', reason: `No description was written: the model gateway refused the request (HTTP ${status}).` };
  }
  if (err.name === 'AbortError' || /abort|timed? ?out/i.test(message)) {
    return { code: 'model-unreachable', reason: 'No description was written: the model did not answer in time.' };
  }
  return { code: 'model-unreachable', reason: 'No description was written: the model could not be reached.' };
}

async function run(id: string, deps: DescribeDeps, actingUserId: string): Promise<DescribeResult> {
  const subject = autoDocsSubject(id);
  if (!subject) return { state: 'skipped', code: 'gone', why: 'the file is no longer stored' };
  if (!(await deps.enabled())) {
    return { state: 'skipped', code: 'disabled', why: 'Automatic descriptions are switched off by the platform admin.' };
  }
  const { asset, text } = subject;
  const eligibility = autoDocsEligibility(asset, text);
  if (!eligibility.eligible) {
    // Restricted / opted out: nothing is recorded and nothing leaves the store. No text: say so.
    if (eligibility.code === 'no-text') recordAutoDocsSkipped(id, 'no-text', eligibility.why);
    return { state: 'skipped', code: eligibility.code, why: eligibility.why };
  }
  const plan = generationPlan(asset);
  if (!plan.description && !plan.tags) {
    return { state: 'skipped', code: 'nothing-to-write', why: 'The description and tags on this file are its owner’s own, so nothing is generated.' };
  }

  const fail = (code: AutoDocsCode, reason: string, detail?: string): DescribeResult => {
    recordAutoDocsFailure(id, code, reason);
    console.warn(`[files] automatic description failed for ${id} (${code})${detail ? `: ${detail}` : ''}`);
    return { state: 'failed', code, reason };
  };

  const model = deps.model();
  if (!model) {
    return fail('not-configured', 'No description was written: no model is configured for the worker role.');
  }

  markAutoDocsPending(id);
  const vocabulary = tagVocabulary(asset);
  // Written in the language of the file's OWNER (the uploader) — also when an admin's backfill
  // pays for it. An unreadable preference is English, never a failure.
  const localeSubject = asset.owner || actingUserId;
  const locale = deps.locale ? await deps.locale(localeSubject).catch(() => 'en') : 'en';
  const messages = buildDescribeMessages({ name: asset.name, folder: asset.folder, kind: asset.kind, text, vocabulary, plan, locale });
  const ctx: DescribeCallContext = { userId: actingUserId, domain: asset.domain || 'platform', model };

  let reply: string;
  try {
    reply = await deps.complete(messages, ctx);
  } catch (e) {
    const { code, reason } = classifyModelError(e);
    return fail(code, reason, (e as Error)?.message);
  }
  let parsed = parseDocsReply(reply, plan, vocabulary);
  if (!parsed.ok) {
    // ONE more attempt, told exactly what was wrong. Then it is a failure, not a guess.
    try {
      reply = await deps.complete(repairMessages(messages, reply, parsed.error, plan), ctx);
    } catch (e) {
      const { code, reason } = classifyModelError(e);
      return fail(code, reason, (e as Error)?.message);
    }
    parsed = parseDocsReply(reply, plan, vocabulary);
    if (!parsed.ok) {
      return fail('bad-output', `No description was written: the model’s answer could not be used. ${parsed.error}`);
    }
  }

  // The write re-checks everything: restricted / opted out / deleted / edited meanwhile.
  const applied = applyGeneratedDocs(id, { description: parsed.description, tags: parsed.tags }, model);
  if (!applied) {
    return { state: 'skipped', code: 'discarded', why: 'the file was restricted, opted out or deleted while its description was being written — the result was discarded' };
  }
  await deps.index(applied.asset, text, actingUserId).catch((e) => {
    console.warn(`[files] re-indexing after an automatic description failed for ${id} — the description is stored: ${(e as Error)?.message ?? String(e)}`);
  });
  return { state: 'done', description: applied.wrote.description, tags: applied.wrote.tags };
}

/**
 * Write a description and tags for one file, as `actingUserId`. Waits up to `waitMs` (default:
 * until done) and then reports `pending` while the work carries on in this process. Concurrent
 * calls for the same file share one run. Never throws.
 */
export async function describeFile(
  id: string,
  deps: DescribeDeps,
  opts: { actingUserId: string; waitMs?: number },
): Promise<DescribeResult> {
  if (!opts.actingUserId) return { state: 'skipped', code: 'disabled', why: 'there is no acting user to run this as' };
  let flight = flights().get(id);
  if (!flight) {
    flight = run(id, deps, opts.actingUserId)
      .catch((e): DescribeResult => {
        const reason = 'No description was written: the run stopped unexpectedly.';
        recordAutoDocsFailure(id, 'model-unreachable', reason);
        console.warn(`[files] automatic description stopped for ${id}: ${(e as Error)?.message ?? String(e)}`);
        return { state: 'failed', code: 'model-unreachable', reason };
      })
      .finally(() => { flights().delete(id); });
    flights().set(id, flight);
  }
  if (opts.waitMs === undefined) return flight;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise<DescribeResult>((resolve) => {
    timer = setTimeout(() => resolve({ state: 'pending' }), Math.max(0, opts.waitMs!));
  });
  try {
    return await Promise.race([flight, pending]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Is a generation for this file running in THIS process right now? */
export function describeInFlight(id: string): boolean {
  return flights().has(id);
}

/** A `pending` with no run behind it (the process was replaced) becomes a retryable `interrupted`. */
export function settleStaleAutoDocs(id: string, staleAfterMs: number, nowMs: number = Date.now()): boolean {
  const generation = autoDocsSubject(id)?.asset.autoDocs?.generation;
  if (generation?.status !== 'pending' || describeInFlight(id)) return false;
  const startedAt = Date.parse(generation.at);
  if (Number.isFinite(startedAt) && nowMs - startedAt < staleAfterMs) return false;
  return Boolean(recordAutoDocsFailure(id, 'interrupted', 'No description was written: the server was restarted while it was being written.'));
}

/** Test hook. */
export function __resetDescribeFlights(): void {
  flights().clear();
  busy(false);
}

// ---------------------------------------------------------------------------
//  The admin backfill: plan (writes nothing) · run (bounded batches)
// ---------------------------------------------------------------------------

export type BackfillPrincipal = { id: string; role: string };

export const BACKFILL_DEFAULT_BATCH = 10;
export const BACKFILL_MAX_BATCH = 50;

function assertAdmin(principal: BackfillPrincipal | null | undefined): void {
  if (!principal?.id || principal.role !== 'admin') {
    throw codedError(principal?.id ? 403 : 401, 'Describing existing files is admin-only', 'files.describeAdminOnly');
  }
}

type Candidate = { asset: FileAsset; text: string };

/** Why a file is, or is not, part of the backfill. */
function classify(row: { asset: FileAsset; text: string; archived: boolean }):
  'candidate' | 'archived' | 'restricted' | 'opt-out' | 'no-text' | 'user-described' | 'described' {
  if (row.archived) return 'archived';
  const eligibility = autoDocsEligibility(row.asset, row.text);
  if (!eligibility.eligible) return eligibility.code;
  if (descriptionOwner(row.asset) === 'user') return 'user-described';
  const plan = generationPlan(row.asset);
  const needsDescription = !row.asset.description.trim();
  const needsTags = row.asset.tags.length === 0 && plan.tags;
  return needsDescription || needsTags ? 'candidate' : 'described';
}

function candidates(): { list: Candidate[]; skipped: Record<string, number> } {
  const skipped: Record<string, number> = { archived: 0, restricted: 0, 'opt-out': 0, 'no-text': 0, 'user-described': 0, described: 0 };
  const list: Candidate[] = [];
  for (const row of listAllForAutoDocs()) {
    const kind = classify(row);
    if (kind === 'candidate') list.push({ asset: row.asset, text: row.text });
    else skipped[kind] += 1;
  }
  list.sort((a, b) => a.asset.id.localeCompare(b.asset.id));
  return { list, skipped };
}

export type ModelPriceLike = { inputPerM: number; outputPerM: number };

export type BackfillPlan = {
  /** Is the admin switch on? Off ⇒ a run would write nothing. */
  enabled: boolean;
  /** Files a run would send to the model. */
  files: number;
  /** Files left alone, by reason. */
  skipped: Record<string, number>;
  /** The model that would be used. */
  model: string;
  /** ESTIMATE: characters ÷ 4 for the prompts, a fixed allowance per reply. */
  estimate: { inputTokens: number; outputTokens: number; cost: number | null; currency: string; priced: boolean };
  /** Whose budget a run is billed to. */
  billedTo: string;
  sample: { id: string; name: string }[];
};

/**
 * DRY RUN. Reads the files, counts what a run would describe and estimates the tokens. Writes
 * nothing, calls no model. `priceOf` is the price book lookup (injected: it lives outside this
 * tab); an unpriced model yields `cost: null`, never an invented 0.
 */
export async function planDescribeBackfill(
  principal: BackfillPrincipal,
  deps: Pick<DescribeDeps, 'enabled' | 'model'>,
  opts: { priceOf?: (model: string) => ModelPriceLike | undefined | Promise<ModelPriceLike | undefined>; currency?: string } = {},
): Promise<BackfillPlan> {
  assertAdmin(principal);
  const { list, skipped } = candidates();
  const model = deps.model();
  let inputTokens = 0;
  for (const { asset, text } of list) {
    const plan = generationPlan(asset);
    inputTokens += estimateInputTokens(
      buildDescribeMessages({ name: asset.name, folder: asset.folder, kind: asset.kind, text, vocabulary: tagVocabulary(asset), plan }),
    );
  }
  const outputTokens = list.length * AUTO_DOCS_LIMITS.outputTokensEstimate;
  const price = opts.priceOf ? await opts.priceOf(model) : undefined;
  const cost = price ? (inputTokens * price.inputPerM + outputTokens * price.outputPerM) / 1_000_000 : null;
  return {
    enabled: Boolean(await deps.enabled()),
    files: list.length,
    skipped,
    model,
    estimate: { inputTokens, outputTokens, cost, currency: opts.currency ?? 'EUR', priced: Boolean(price) },
    billedTo: principal.id,
    sample: list.slice(0, 10).map(({ asset }) => ({ id: asset.id, name: asset.name })),
  };
}

const BUSY_KEY = Symbol.for('soa.files.describe.backfill.busy');
function busy(set?: boolean): boolean {
  const g = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (set !== undefined) g[BUSY_KEY] = set;
  return Boolean(g[BUSY_KEY]);
}

export type BackfillRun = {
  started: boolean;
  /** Why nothing ran, or why the batch stopped early. */
  reason?: string;
  processed: number;
  described: number;
  skipped: number;
  failures: { id: string; name: string; reason: string }[];
  /** Pass back as `after` to continue this sequence. */
  cursor: string | null;
  /** Candidates left after this batch (beyond the cursor). */
  remaining: number;
  done: boolean;
};

/** Failures that mean "the model is not available to anyone right now": stop, do not walk the corpus. */
const STOP_CODES: AutoDocsCode[] = ['model-unreachable', 'not-configured', 'budget', 'model-rejected'];

/**
 * ONE BOUNDED BATCH, billed to the admin who runs it. Call again with the returned `cursor` to
 * continue; call with no cursor to start over — which re-reads the files, so anything already
 * described is not touched again.
 */
export async function runDescribeBackfill(
  principal: BackfillPrincipal,
  deps: DescribeDeps,
  opts: { batch?: number; after?: string | null } = {},
): Promise<BackfillRun> {
  assertAdmin(principal);
  const empty = { processed: 0, described: 0, skipped: 0, failures: [], cursor: opts.after ?? null };
  if (!(await deps.enabled())) {
    return { started: false, reason: 'Automatic descriptions are switched off. Switch them on to describe existing files.', ...empty, remaining: 0, done: true };
  }
  if (busy()) {
    return { started: false, reason: 'A batch is already running. Wait for it to finish, then continue.', ...empty, remaining: 0, done: false };
  }
  const size = Math.min(BACKFILL_MAX_BATCH, Math.max(1, Math.floor(opts.batch ?? BACKFILL_DEFAULT_BATCH)));
  const todo = candidates().list.filter(({ asset }) => !opts.after || asset.id > opts.after);
  const slice = todo.slice(0, size);
  const out: BackfillRun = { started: true, processed: 0, described: 0, skipped: 0, failures: [], cursor: opts.after ?? null, remaining: 0, done: false };
  busy(true);
  try {
    for (const { asset } of slice) {
      const result = await describeFile(asset.id, deps, { actingUserId: principal.id });
      if (result.state === 'failed' && STOP_CODES.includes(result.code)) {
        // The cursor stays BEFORE this file, so continuing retries it.
        out.reason = result.reason;
        out.failures.push({ id: asset.id, name: asset.name, reason: result.reason });
        break;
      }
      out.processed += 1;
      out.cursor = asset.id;
      if (result.state === 'done') out.described += 1;
      else if (result.state === 'failed') out.failures.push({ id: asset.id, name: asset.name, reason: result.reason });
      else out.skipped += 1;
    }
  } finally {
    busy(false);
  }
  out.remaining = todo.length - out.processed;
  out.done = out.remaining === 0 && !out.reason;
  return out;
}
