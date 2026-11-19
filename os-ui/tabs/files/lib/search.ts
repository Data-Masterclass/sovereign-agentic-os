/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        files
 * FEATURE:    File search — lexical (BM25) + semantic (k-NN over the stored vectors), fused
 * USER STORY: As someone searching my files (the Files tab box, or an agent's `search_files`) I
 *             want the passage that MEANS what I asked even when it shares none of my words, the
 *             exact name/tag match still on top, and never a file I may not read.
 * ARCHITECTURE:
 *   - Until 2026-11-20 both doors ran `searchFiles` (store.ts), a keyword scan over the in-memory
 *     registry. The `files` OpenSearch index — chunk text + a vector per chunk, written on every
 *     upload and paid for in embeddings — was read by nothing on those paths.
 *   - THREE ranked lists, fused by reciprocal rank fusion (`core/kernel/rank-fusion.ts`):
 *       1. lexical  — OpenSearch BM25 (`multi_match`) over chunk text, name, tags, description;
 *       2. semantic — OpenSearch k-NN over the chunk vectors, the query embedded once;
 *       3. keyword  — the registry scan (current name / folder / tags / description).
 *     Fusion by RANK, not score: no list gates another (a dense-only hit counts) and no cluster
 *     search pipeline is needed (OpenSearch's `hybrid` query requires one). Apache-2.0 throughout.
 *   - DLS twice. The compiled filter (`compileDls` → `toIndexDls`) goes INTO both OpenSearch
 *     queries (inside k-NN as an efficient filter; a post-filter if the engine refuses that).
 *     Then every candidate file is re-read through `getFile(id, user)` — the Files tab's own
 *     gate — because the index holds a SNAPSHOT of owner/tier/grants from index time: a file
 *     un-shared, archived, deleted or made restricted since is dropped here. Restricted and
 *     stored-only files never surface.
 *   - Honest fallback. OpenSearch unreachable → the keyword scan alone, `mode: 'keyword-only'`,
 *     labelled {@link KEYWORD_ONLY_NOTE}. Gateway down (or a stand-in hash vector, which has no
 *     relation to the stored real vectors) → BM25 + keyword, `mode: 'lexical'`, said so.
 *     Nothing is ever invented.
 *   - A semantic FLOOR (`config.searchSemanticMinCosine`, default cosine 0.3): k-NN always returns
 *     the k nearest chunks, related or not; below the floor a chunk is not a match.
 *   - Cost: ONE embedding call per search (the query, a few tokens), billed to the searching user.
 */
import { config } from '@core/kernel/config';
import { reciprocalRankFusion, l2ScoreForCosine } from '@core/kernel/rank-fusion';
import { compileDls, toIndexDls } from '@tabs/files/lib/dls';
import { embedQuery } from '@tabs/files/lib/embed';
import { searchFilesRanked, getFile, type Principal, type SearchHit } from '@tabs/files/lib/store';

export type FileSearchMode = 'hybrid' | 'lexical' | 'keyword-only';
export type MatchedBy = 'lexical' | 'semantic' | 'keyword';
export type FileSearchHit = SearchHit & { matchedBy: MatchedBy[] };
export type FileSearchResult = { query: string; mode: FileSearchMode; total: number; hits: FileSearchHit[]; note?: string };

export type OsHit = { _id: string; _score: number; _source: Record<string, unknown> };
/** `rejected` = OpenSearch answered 4xx to THIS query shape; `unreachable` = no usable answer. */
export type OsSearch = { status: 'ok'; hits: OsHit[] } | { status: 'rejected' } | { status: 'unreachable' };

export type FileSearchDeps = {
  embed?: (text: string, user: Principal) => Promise<{ vector: number[]; mode: 'live' | 'mock' }>;
  search?: (body: Record<string, unknown>) => Promise<OsSearch>;
  /** How long to wait for the query vector before answering lexically (default {@link EMBED_WAIT_MS}). */
  embedWaitMs?: number;
};

/** The query embedding gets this long; the gateway's own timeout is 8 s, too long for a search box. */
export const EMBED_WAIT_MS = 2500;

export const KEYWORD_ONLY_NOTE = 'keyword only (search index unavailable): matched on file names, tags, descriptions and text words; meaning-based matches are missing until the search index answers again.';
const LEXICAL_ONLY_NOTE = 'The semantic half was skipped (the embedding gateway did not give a usable query vector): these hits match your words, not your meaning.';

/** How many hits a search returns at most (the UI box and `search_files`). */
export const SEARCH_TOP_K = 20;
/** Chunks fetched per half; several chunks of one file collapse to that file. */
const CANDIDATES = 50;

function tokens(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** A short window around the first query word, else the start of the passage. */
function snippetOf(text: string, query: string): string {
  if (!text) return '';
  const q = new Set(tokens(query));
  const words = text.split(/\s+/);
  const idx = words.findIndex((w) => q.has(w.toLowerCase().replace(/[^a-z0-9]/g, '')));
  if (idx < 0) return text.length > 180 ? text.slice(0, 180) + '…' : text;
  const start = Math.max(0, idx - 8);
  const end = Math.min(words.length, idx + 16);
  return (start > 0 ? '…' : '') + words.slice(start, end).join(' ') + (end < words.length ? '…' : '');
}

async function liveSearch(body: Record<string, unknown>): Promise<OsSearch> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`${config.opensearchUrl}/${config.filesIndex}/_search`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store', signal: ctrl.signal,
    });
    // 404 = no `files` index at all: the index is unavailable, not the query wrong.
    if (res.status === 400) return { status: 'rejected' };
    if (!res.ok) return { status: 'unreachable' };
    const json = (await res.json()) as { hits?: { hits?: OsHit[] } };
    return { status: 'ok', hits: json.hits?.hits ?? [] };
  } catch {
    return { status: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

const liveEmbed: NonNullable<FileSearchDeps['embed']> = (text, user) =>
  embedQuery(text, { userId: user.id, domain: user.domains[0], tab: 'files' });

/** The BM25 half: chunk text + the file's name, tags and description, DLS as a filter. */
export function lexicalBody(query: string, dls: Record<string, unknown>): Record<string, unknown> {
  return {
    size: CANDIDATES,
    _source: { includes: ['file_id', 'text'] },
    query: {
      bool: {
        must: [{ multi_match: { query, fields: ['name^3', 'tags^2', 'description^2', 'text'], type: 'best_fields', fuzziness: 'AUTO' } }],
        filter: [dls],
      },
    },
  };
}

/** The k-NN half with the DLS as an EFFICIENT filter (applied during the search, so k stays k). */
export function denseBody(vector: number[], dls: Record<string, unknown>): Record<string, unknown> {
  return { size: CANDIDATES, _source: { includes: ['file_id', 'text'] }, query: { knn: { vector: { vector, k: CANDIDATES, filter: dls } } } };
}

/** The k-NN half as a POST-filter — for an engine that refuses a filter inside k-NN. */
export function densePostFilterBody(vector: number[], dls: Record<string, unknown>): Record<string, unknown> {
  return { size: CANDIDATES, _source: { includes: ['file_id', 'text'] }, query: { bool: { must: [{ knn: { vector: { vector, k: CANDIDATES * 4 } } }], filter: [dls] } } };
}

/** Collapse chunk hits to files (best chunk first) and remember each file's best passage. */
function byFile(res: OsSearch, passages: Map<string, string>, minScore = 0): string[] | null {
  if (res.status !== 'ok') return null;
  const ids: string[] = [];
  for (const h of res.hits) {
    if (h._score < minScore) continue; // below the semantic floor: nearest, but not related
    const fileId = String(h._source.file_id ?? String(h._id).split('#')[0]);
    if (!fileId || ids.includes(fileId)) continue;
    ids.push(fileId);
    if (!passages.has(fileId)) passages.set(fileId, String(h._source.text ?? ''));
  }
  return ids;
}

export async function searchFilesHybrid(user: Principal, rawQuery: string, deps: FileSearchDeps = {}): Promise<FileSearchResult> {
  const query = rawQuery.trim();
  if (!query) return { query, mode: 'hybrid', total: 0, hits: [] };
  const embed = deps.embed ?? liveEmbed;
  const search = deps.search ?? liveSearch;

  // The registry scan: current metadata, the Files tab's own DLS. Also the fallback.
  // The whole ranking, not the top-k: it is fused below, and its length is the keyword-only total.
  const keyword = searchFilesRanked(user, query, Infinity).hits;
  const dls = toIndexDls(compileDls({ id: user.id, domains: user.domains }));

  // A slow gateway must not stall the search box: past EMBED_WAIT_MS the lexical half answers alone.
  const vectorP = Promise.race([
    embed(query, user).then((r) => (r.mode === 'live' && r.vector.length > 0 ? r.vector : null), () => null),
    new Promise<null>((resolve) => { const t = setTimeout(() => resolve(null), deps.embedWaitMs ?? EMBED_WAIT_MS); (t as { unref?: () => void }).unref?.(); }),
  ]);
  const [lexRes, vector] = await Promise.all([search(lexicalBody(query, dls)), vectorP]);
  let denseRes: OsSearch | null = null;
  if (vector) {
    denseRes = await search(denseBody(vector, dls));
    if (denseRes.status === 'rejected') denseRes = await search(densePostFilterBody(vector, dls));
  }

  const lexPassages = new Map<string, string>();
  const densePassages = new Map<string, string>();
  const lexIds = byFile(lexRes, lexPassages);
  const denseIds = denseRes ? byFile(denseRes, densePassages, l2ScoreForCosine(config.searchSemanticMinCosine)) : null;

  if (!lexIds && !denseIds) {
    const hits = keyword.slice(0, SEARCH_TOP_K).map((h) => ({ ...h, matchedBy: ['keyword'] as MatchedBy[] }));
    return { query, mode: 'keyword-only', total: keyword.length, hits, note: KEYWORD_ONLY_NOTE };
  }
  const mode: FileSearchMode = denseIds ? 'hybrid' : 'lexical';

  const fused = reciprocalRankFusion([
    { name: 'lexical', ids: lexIds ?? [] },
    { name: 'semantic', ids: denseIds ?? [] },
    { name: 'keyword', ids: keyword.map((h) => h.id) },
  ]);
  const keywordById = new Map(keyword.map((h) => [h.id, h]));

  const verified: FileSearchHit[] = [];
  for (const f of fused) {
    // The Files tab's own gate, on CURRENT state: unknown / not permitted → skip, never show.
    let view: ReturnType<typeof getFile>;
    try { view = getFile(f.id, user); } catch { continue; }
    const a = view.asset;
    if (view.archived || a.indexing.mode === 'stored-only' || a.sensitivity === 'restricted') continue;
    const passage = lexPassages.get(f.id) ?? densePassages.get(f.id);
    verified.push({
      id: a.id, name: a.name, owner: a.owner, folder: a.folder, tags: a.tags, kind: a.kind, deepLink: a.deepLink,
      score: Number(f.score.toFixed(5)),
      snippet: passage !== undefined ? snippetOf(passage, query) : keywordById.get(f.id)?.snippet ?? '',
      matchedBy: f.foundBy as MatchedBy[],
    });
  }
  const total = verified.length;
  const parts: string[] = [];
  if (mode === 'lexical') parts.push(LEXICAL_ONLY_NOTE);
  if (total > SEARCH_TOP_K) parts.push(`${total} files match; showing the top ${SEARCH_TOP_K} of ${total} by relevance.`);
  return { query, mode, total, hits: verified.slice(0, SEARCH_TOP_K), ...(parts.length ? { note: parts.join(' ') } : {}) };
}
