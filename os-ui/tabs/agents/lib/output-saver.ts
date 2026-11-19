/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       agents
 * FEATURE:    Declared outputs are saved by the engine when a run produces its result
 * USER STORY: As an author I chose "Where the results go" on the first step. After a run I want
 *             the report in that Files folder, the note in that Knowledge folder and the rows in
 *             that dataset — without depending on a model remembering to call a tool with the
 *             right path — and I want the run to tell me, per output, where it went or why not.
 * ARCHITECTURE:
 *   - THE MODEL PRODUCES, THE PRODUCT FILES. `saveDeclaredOutputs` takes the finished run's
 *     per-agent results and, for every declared output, writes the result of the agent that
 *     produces it ("written by", else the final agent) to the declared folder. Deterministic
 *     code, one output after the other; no model is asked.
 *   - ONE DOOR, INJECTED. Every write and every read goes through `dispatch(tool, args)`. In
 *     production that is the governed agent gate as the RUNNING USER (`build/output-save-server.ts`):
 *     the same MCP tools a person would use, the same folder check (`build/grant-scope.ts`), the
 *     same audit trail. This module is pure — it never imports a store — which is also what makes
 *     the whole sequence testable with a fake dispatch.
 *   - PER KIND: a File is `upload_file`; a Knowledge output is a note (`save_knowledge_note`); a
 *     Data output is the ONE table in the result (`output-table.ts`) landed as the Bronze of one
 *     dataset per output (`create_dataset` once, `ingest_dataset` per run). No table → nothing is
 *     invented, the output says so.
 *   - A DOMAIN TARGET IS A MY WRITE PLUS A REQUEST. The write lands in the runner's own lane at
 *     the declared path; sharing it is `request_promotion`, which files the request a domain admin
 *     decides. The engine files it and never decides it.
 *   - THE HOLD RULE STILL APPLIES (`build/hold.ts`): under the read-only preset nothing is written
 *     by a run. The person can save it by hand ("Save now"), which is their own act.
 *   - EXACTLY ONCE. Before anything is written the saver looks for what THIS RUN already saved:
 *     the ledger of the run (`previous`), then the store itself — a file whose name carries the
 *     run's tag, a note under the run's `sourceKey`, the dataset of that name and a Bronze built
 *     at or after the run's result (its rows are not landed twice). So a run resumed
 *     after a crash between the write and the bookkeeping finds its own work instead of
 *     repeating it.
 *   - SAID ONLY WHEN CONFIRMED. A save is reported after the id was read back through the door.
 */
import { normaliseFolderPath } from '@core/kernel/folders';
import { holdDecisionFor } from '@tabs/agents/lib/build/hold';
import { outputIsWritable } from '@tabs/agents/lib/output-tools';
import { extractTable } from '@tabs/agents/lib/output-table';
import type { ArtifactGrant, DeclaredOutput, OutputKind, System } from '@tabs/agents/lib/system-schema';

/** The governed door: one tool call, as the running user. */
export type OutputDispatch = (tool: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;

/** The tools the saver drives, per kind — exactly what its door needs to offer and nothing else. */
export const SAVE_TOOLS: Record<OutputKind, string[]> = {
  files: ['upload_file', 'list_files', 'get_file'],
  knowledge: ['save_knowledge_note'],
  data: ['create_dataset', 'ingest_dataset', 'list_datasets', 'get_dataset'],
};
export const PROMOTION_TOOL = 'request_promotion';

/** The tool whose hold decides whether a run may write an output of this kind. */
const WRITE_TOOL: Record<OutputKind, string> = { files: 'upload_file', knowledge: 'save_knowledge_note', data: 'create_dataset' };
const PROMOTION_KIND: Record<OutputKind, string> = { files: 'file', knowledge: 'personal_knowledge', data: 'dataset' };
const LANE: Record<OutputKind, string> = { files: 'files', knowledge: 'knowledge', data: 'data' };
const TAB_PATH: Record<OutputKind, string> = { files: '/files', knowledge: '/knowledge', data: '/data' };

export type OutputState =
  /** Written and read back. */
  | 'saved'
  /** Deliberately not written (no table, read-only team, the producing agent failed). */
  | 'not_saved'
  /** A write was attempted and did not succeed, or could not be confirmed. */
  | 'failed'
  /** Not attempted yet: the run has not finished, or the save is in progress. */
  | 'pending';

export type OutputPromotion = {
  /** `requested` = filed and waiting for a domain admin; `shared` = already a Domain item. */
  state: 'requested' | 'shared' | 'not_requested';
  approvalId?: string;
  reason?: string;
};

export type OutputResult = {
  /** The output's identity within the system (kind + lane + folder + name) — survives reordering. */
  key: string;
  index: number;
  kind: OutputKind;
  name: string;
  target: { scope: 'personal' | 'domain'; path: string };
  /** The agent whose result this is. */
  producer?: string;
  state: OutputState;
  /** The saved item: its id, its name/title, and where to open it. */
  id?: string;
  item?: string;
  link?: string;
  /** Data only: the rows that landed. */
  rows?: number;
  promotion?: OutputPromotion;
  reason?: string;
  /** What "Try saving again" can do: repeat the save, or only the person's own save. Absent = nothing. */
  retry?: 'again' | 'by-hand';
  /** One plain sentence — the thing the run report, the panel and MCP all show. */
  message: string;
};

export type ProducerRun = { node: string; status: string; finalText: string };

export type SaveOutputsInput = {
  /** The system the run executed (its declared outputs, folder grants and safety preset). */
  system: System;
  systemId: string;
  runId: string;
  /** When the run produced its result (ms) — the timestamp in file names and note titles. */
  at: number;
  /** How the run ended (`run-status.ts`). */
  status: 'done' | 'failed' | 'parked' | 'interrupted' | 'incomplete';
  failure?: { node: string | null; reason: string };
  /** Every agent visit, in order, with its result. */
  nodes: ProducerRun[];
  /** The running user's id — a dataset of the same name that is someone else's is never written. */
  runnerId: string;
  dispatch: OutputDispatch;
  /** What this run already recorded (its ledger). A `saved` entry is not written again. */
  previous?: OutputResult[];
  /**
   * `run` = the engine, at the end of a run. `by-hand` = the person pressed "Save now": their own
   * act, so the read-only hold of the TEAM does not apply and a run that did not finish can still
   * have a finished agent's result saved.
   */
  mode?: 'run' | 'by-hand';
  /** Save only these outputs (by key). Absent = all. */
  only?: string[];
};

// ------------------------------------------------------------------ scope --

/**
 * THE SCOPE THE SAVE RUNS UNDER: the run's system reduced to what saving its declared outputs
 * needs, and nothing more. Its tools are the saver's own ({@link SAVE_TOOLS}, plus the promotion
 * request when a Domain target is declared). Its resource grants are the declared folders only:
 * each as a writable folder in the runner's MY lane (where the write lands) and, for a Domain
 * target, the declared Domain folder as well (where an item shared earlier is found again).
 * Every other grant of the system is dropped — the save can read and write nothing the
 * declaration does not name. The folder check itself is the run's own (`build/grant-scope.ts`).
 */
export function outputSaveSystem(input: System): System {
  const sys = structuredClone(input);
  const outputs = (input.outputs ?? []).filter((o) => outputIsWritable(input, o));
  const tools = new Set<string>();
  const grants: Record<OutputKind, ArtifactGrant[]> = { files: [], knowledge: [], data: [] };
  for (const o of outputs) {
    for (const t of SAVE_TOOLS[o.kind]) tools.add(t);
    const path = normaliseFolderPath(o.folder.path);
    const scopes: ('personal' | 'domain')[] = o.folder.scope === 'domain' ? ['personal', 'domain'] : ['personal'];
    if (o.folder.scope === 'domain') tools.add(PROMOTION_TOOL);
    for (const scope of scopes) {
      if (!grants[o.kind].some((g) => g.folder?.scope === scope && g.folder.path === path)) {
        grants[o.kind].push({ id: '', capability: 'Write-bounded', folder: { path, scope } });
      }
    }
  }
  sys.grants = { tools: [...tools], data: grants.data, knowledge: grants.knowledge, files: grants.files, metrics: [], connections: [], plan: [] };
  return sys;
}

// ----------------------------------------------------------------- naming --

const slug = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'result';

/** Eight characters that identify the run inside a name (`run_1b4e28ba-…` → `1b4e28ba`). */
export function runTag(runId: string): string {
  const hex = runId.replace(/^run_/, '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  return hex.slice(0, 8) || 'run';
}

const pad = (n: number) => String(n).padStart(2, '0');
/** `2026-11-19-1405` (UTC) — sortable, and safe in a file name. */
export function stamp(at: number): string {
  const d = new Date(at);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
}
const readableStamp = (at: number): string => {
  const s = stamp(at);
  return `${s.slice(0, 10)} ${s.slice(11, 13)}:${s.slice(13, 15)} UTC`;
};

/** The identity of a declared output inside its system. */
export function outputKey(o: DeclaredOutput): string {
  return `${o.kind}:${o.folder.scope}:${normaliseFolderPath(o.folder.path)}:${o.name.trim().toLowerCase()}`;
}

/** The key that identifies ONE save: this run, this output. */
export function saveKey(systemId: string, runId: string, o: DeclaredOutput): string {
  return `agent-output:${systemId}:${runId}:${outputKey(o)}`;
}

/**
 * THE FILE NAME: `<system>-<yyyy-mm-dd-hhmm>-<run tag>.md`, with the output's own name added when
 * the system declares more than one File output. The run tag makes it unique per run — two runs in
 * the same minute, or a second system of the same name, cannot collide — so a file is never
 * overwritten, and two files never share a name in one folder (same-name files in one folder
 * share an object key today; unique names stay clear of that).
 */
export function outputFileName(sys: System, o: DeclaredOutput, runId: string, at: number): string {
  const many = (sys.outputs ?? []).filter((x) => x.kind === 'files').length > 1;
  return `${filePrefix(sys, o, many)}-${stamp(at)}-${runTag(runId)}.md`;
}
const filePrefix = (sys: System, o: DeclaredOutput, many: boolean): string =>
  many ? `${slug(sys.system.name)}-${slug(o.name)}` : slug(sys.system.name);

/** The note title: the output's name and when the run produced it. */
export function outputNoteTitle(o: DeclaredOutput, at: number): string {
  return `${o.name.trim()} — ${readableStamp(at)}`;
}

// ---------------------------------------------------------------- helpers --

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The reason inside a tool's error result, in words (the typed envelope, or the text itself). */
export function errorReason(text: string): string {
  const p = parse(text);
  const err = isRecord(p) ? p.error : undefined;
  const reason = isRecord(err) ? str(err.reason) || str(err.message) : str(err);
  const out = (reason || text || 'the tool returned no reason').replace(/\s+/g, ' ').trim();
  return out.length > 320 ? `${out.slice(0, 319)}…` : out;
}

/** Every row object under the listing keys a list tool answers with (raw, or shaped for an agent). */
function listedRows(text: string): Record<string, unknown>[] {
  const p = parse(text);
  if (!isRecord(p)) return [];
  const out: Record<string, unknown>[] = [];
  for (const key of ['items', 'mine', 'domain', 'marketplace']) {
    const v = p[key];
    if (Array.isArray(v)) for (const row of v) if (isRecord(row) && str(row.id)) out.push(row);
  }
  return out;
}

const where = (path: string): string => (path === '/' ? '/' : path);
const fileAt = (path: string, name: string): string => (path === '/' ? `/${name}` : `${path}/${name}`);
const linkTo = (kind: OutputKind, id: string): string => `${TAB_PATH[kind]}?focus=${encodeURIComponent(id)}`;

/** The agent whose result an output is: the one it names, else the last agent that ran. */
export function producerOf(sys: System, o: DeclaredOutput, nodes: ProducerRun[]): { id: string | null; run: ProducerRun | null } {
  const named = o.agent && sys.agents.some((a) => a.id === o.agent) ? o.agent : null;
  if (named) {
    const run = [...nodes].reverse().find((n) => n.node === named) ?? null;
    return { id: named, run };
  }
  const last = nodes.at(-1) ?? null;
  return { id: last?.node ?? null, run: last };
}

type Base = Pick<OutputResult, 'key' | 'index' | 'kind' | 'name' | 'target' | 'producer'>;
type Saved = { id: string; item: string; rows?: number; note?: string };
type Attempt = { ok: true; saved: Saved } | { ok: false; state: 'not_saved' | 'failed'; reason: string; retry?: OutputResult['retry'] };

const notSaved = (base: Base, reason: string, retry?: OutputResult['retry']): OutputResult => ({
  ...base, state: 'not_saved', reason, ...(retry ? { retry } : {}), message: `Not saved: ${reason}`,
});

function savedMessage(base: Base, s: Saved, promotion?: OutputPromotion): string {
  const path = base.target.path;
  let head: string;
  if (base.kind === 'files') head = `Saved to My files ${fileAt(path, s.item)}`;
  else if (base.kind === 'knowledge') head = `Saved to My knowledge ${where(path)} as “${s.item}”`;
  else head = `Saved to My data ${where(path)} as “${s.item}”${typeof s.rows === 'number' ? ` (${s.rows} row${s.rows === 1 ? '' : 's'}${s.note ? `, ${s.note}` : ''})` : ''}`;
  if (!promotion) return head;
  const domain = `Domain ${LANE[base.kind]} ${where(path)}`;
  if (promotion.state === 'requested') return `${head}; promotion to ${domain} requested, waiting for a domain admin`;
  if (promotion.state === 'shared') return `${head}; it is already shared with the domain`;
  return `${head}; promotion to ${domain} was not requested: ${promotion.reason ?? 'the request was refused'}`;
}

// ------------------------------------------------------------- per kind ----

async function saveFile(input: SaveOutputsInput, o: DeclaredOutput, text: string, producer: string | null): Promise<Attempt> {
  const { dispatch, system: sys } = input;
  const path = normaliseFolderPath(o.folder.path);
  const tag = runTag(input.runId);
  const many = (sys.outputs ?? []).filter((x) => x.kind === 'files').length > 1;
  const prefix = `${filePrefix(sys, o, many)}-`;
  // What this run already wrote here: a file of this output whose name ends in the run's tag.
  const listing = await dispatch('list_files', { folder: path });
  if (listing.isError) return { ok: false, state: 'failed', reason: `the folder could not be checked before writing (${errorReason(listing.text)})`, retry: 'again' };
  const mine = listedRows(listing.text).find(
    (r) => normaliseFolderPath(str(r.folder)) === path && str(r.name).startsWith(prefix) && str(r.name).endsWith(`-${tag}.md`),
  );
  let id = mine ? str(mine.id) : '';
  let name = mine ? str(mine.name) : outputFileName(sys, o, input.runId, input.at);
  if (!id) {
    const res = await dispatch('upload_file', {
      name,
      folder: path,
      text,
      description: `Result of the agent system “${sys.system.name}”${producer ? ` (agent ${producer})` : ''}, run ${input.runId}, ${readableStamp(input.at)}. Output “${o.name.trim()}”.`,
      tags: ['agent-output', slug(sys.system.name)],
      sensitivity: 'internal',
    });
    if (res.isError) return { ok: false, state: 'failed', reason: errorReason(res.text), retry: 'again' };
    const made = parse(res.text);
    id = isRecord(made) ? str(made.id) : '';
    if (isRecord(made) && str(made.name)) name = str(made.name);
    if (!id) return { ok: false, state: 'failed', reason: 'the upload answered without a file id', retry: 'again' };
  }
  const back = parse((await dispatch('get_file', { fileId: id })).text);
  if (!isRecord(back) || str(back.id) !== id) return { ok: false, state: 'failed', reason: 'the file could not be read back after the write', retry: 'again' };
  return { ok: true, saved: { id, item: name } };
}

async function saveNote(input: SaveOutputsInput, o: DeclaredOutput, text: string, producer: string | null): Promise<Attempt> {
  const { dispatch, system: sys } = input;
  const path = normaliseFolderPath(o.folder.path);
  const args = {
    title: outputNoteTitle(o, input.at),
    md: `${text.trim()}\n\n---\n_Result of the agent system “${sys.system.name}”${producer ? ` · agent ${producer}` : ''} · run ${input.runId} · ${readableStamp(input.at)}_\n`,
    folder: path,
    // The tool returns the note already saved under this key instead of writing a second one.
    sourceKey: saveKey(input.systemId, input.runId, o),
  };
  const res = await dispatch('save_knowledge_note', args);
  if (res.isError) return { ok: false, state: 'failed', reason: errorReason(res.text), retry: 'again' };
  const made = parse(res.text);
  const id = isRecord(made) ? str(made.id) : '';
  if (!id) return { ok: false, state: 'failed', reason: 'the note was answered without an id', retry: 'again' };
  // Read back by the key: the store must answer with the SAME note, as one it already holds.
  const back = parse((await dispatch('save_knowledge_note', args)).text);
  if (!isRecord(back) || str(back.id) !== id || back.already !== true) {
    return { ok: false, state: 'failed', reason: 'the note could not be read back after the write', retry: 'again' };
  }
  return { ok: true, saved: { id, item: str((made as Record<string, unknown>).title) || args.title } };
}

async function saveTable(input: SaveOutputsInput, o: DeclaredOutput, text: string): Promise<Attempt> {
  const { dispatch } = input;
  const path = normaliseFolderPath(o.folder.path);
  const table = extractTable(text);
  if (!table.ok) {
    return { ok: false, state: 'not_saved', reason: table.reason === 'no table in the result' ? 'no table in the result, nothing saved to Data' : `${table.reason}, nothing saved to Data` };
  }
  const name = o.name.trim();
  // ONE dataset per output: the dataset of this name in the declared folder is reused, and each
  // run lands as its next version.
  const listing = await dispatch('list_datasets', {});
  if (listing.isError) return { ok: false, state: 'failed', reason: `the folder could not be checked before writing (${errorReason(listing.text)})`, retry: 'again' };
  const existing = listedRows(listing.text).find(
    (r) => str(r.name).trim().toLowerCase() === name.toLowerCase() && normaliseFolderPath(str(r.folder)) === path,
  );
  if (existing && str(existing.owner) && str(existing.owner) !== input.runnerId) {
    return { ok: false, state: 'not_saved', reason: `a dataset named “${name}” in this folder belongs to someone else — give this output another name` };
  }
  let id = existing ? str(existing.id) : '';
  if (!id) {
    const res = await dispatch('create_dataset', { name, folder: path });
    if (res.isError) return { ok: false, state: 'failed', reason: errorReason(res.text), retry: 'again' };
    const made = parse(res.text);
    id = isRecord(made) ? str(made.id) : '';
    if (!id) return { ok: false, state: 'failed', reason: 'the dataset was answered without an id', retry: 'again' };
  }
  // EXACTLY ONCE for rows too: a Bronze built at or after the moment this run produced its
  // result was landed by this run (a resume after a crash between the ingest and the
  // bookkeeping) or by a newer run — either way these rows are not landed again, and an older
  // run never replaces a newer run's rows.
  if (existing) {
    const landedAt = bronzeBuiltAt(parse((await dispatch('get_dataset', { datasetId: id })).text), id);
    if (landedAt !== null && landedAt >= input.at) {
      return { ok: true, saved: { id, item: name, rows: table.rows.length, note: 'already landed' } };
    }
  }
  const res = await dispatch('ingest_dataset', { datasetId: id, content: table.csv, fileName: `${slug(name)}-${runTag(input.runId)}.csv` });
  if (res.isError) return { ok: false, state: 'failed', reason: `the dataset “${name}” exists, but the rows did not land: ${errorReason(res.text)}`, retry: 'again' };
  const back = parse((await dispatch('get_dataset', { datasetId: id })).text);
  const bronze = isRecord(back) && isRecord(back.versions) && isRecord(back.versions.bronze) ? back.versions.bronze.built : undefined;
  if (!isRecord(back) || str(back.id) !== id || bronze === false) {
    return { ok: false, state: 'failed', reason: 'the dataset could not be read back with its rows after the write', retry: 'again' };
  }
  return { ok: true, saved: { id, item: name, rows: table.rows.length, note: existing ? 'new version' : 'new dataset' } };
}

/** When the dataset's Bronze was last built (ms), from a `get_dataset` answer; null when unbuilt or unknown. */
function bronzeBuiltAt(back: unknown, id: string): number | null {
  if (!isRecord(back) || str(back.id) !== id || !isRecord(back.versions) || !isRecord(back.versions.bronze)) return null;
  const b = back.versions.bronze;
  if (b.built !== true) return null;
  const t = Date.parse(str(b.updatedAt));
  return Number.isFinite(t) ? t : null;
}

/** File the My → Domain request for a saved item. Never decides it. */
async function requestPromotion(dispatch: OutputDispatch, kind: OutputKind, id: string): Promise<OutputPromotion> {
  const res = await dispatch(PROMOTION_TOOL, { kind: PROMOTION_KIND[kind], id });
  if (res.isError) {
    const reason = errorReason(res.text);
    if (/already (shared|promoted)/i.test(reason)) return { state: 'shared' };
    return { state: 'not_requested', reason };
  }
  const handle = parse(res.text);
  const approvalId = isRecord(handle) ? str(handle.approvalId) || str(handle.requestId) : '';
  if (!approvalId) return { state: 'not_requested', reason: 'the request was answered without an id' };
  return { state: 'requested', approvalId };
}

// ------------------------------------------------------------------- main --

/**
 * Save every declared output of one finished run. Never throws: each output ends in exactly one
 * {@link OutputResult}, and one output failing does not stop the next.
 */
export async function saveDeclaredOutputs(input: SaveOutputsInput): Promise<OutputResult[]> {
  const sys = input.system;
  const mode = input.mode ?? 'run';
  const outputs = sys.outputs ?? [];
  const results: OutputResult[] = [];
  for (let index = 0; index < outputs.length; index += 1) {
    const o = outputs[index];
    const key = outputKey(o);
    const { id: producerId, run: producerRun } = producerOf(sys, o, input.nodes);
    const base: Base = {
      key, index, kind: o.kind, name: o.name.trim(),
      target: { scope: o.folder.scope, path: normaliseFolderPath(o.folder.path) },
      ...(producerId ? { producer: producerId } : {}),
    };
    const before = input.previous?.find((p) => p.key === key);
    if (input.only && !input.only.includes(key)) {
      if (before) results.push({ ...before, index });
      continue;
    }

    let saved: Saved | null = before?.state === 'saved' && before.id ? { id: before.id, item: before.item ?? base.name, rows: before.rows } : null;
    let promotion = saved ? before?.promotion : undefined;

    if (!saved) {
      if (!outputIsWritable(sys, o)) {
        results.push(notSaved(base, 'the Write access of this folder was turned off under “What your team can use”'));
        continue;
      }
      const text = producerRun && producerRun.status === 'ok' ? producerRun.finalText.trim() : '';
      const byHandPossible = text ? ('by-hand' as const) : undefined;
      if (mode === 'run' && input.status !== 'done') {
        if (input.status === 'parked' || input.status === 'interrupted') {
          results.push({ ...base, state: 'pending', reason: 'the run has not finished', message: 'Not saved yet: the run has not finished' });
        } else if (input.status === 'failed') {
          const at = input.failure?.node ? ` at ${input.failure.node}` : '';
          results.push(notSaved(base, `the run failed${at}, so nothing was saved`, byHandPossible));
        } else {
          results.push(notSaved(base, 'the run stopped before it finished, so nothing was saved', byHandPossible));
        }
        continue;
      }
      if (!producerRun) {
        results.push(notSaved(base, producerId ? `the agent ${producerId} did not run, so there is no result to save` : 'no agent ran, so there is no result to save'));
        continue;
      }
      if (producerRun.status !== 'ok') {
        results.push(notSaved(base, `the agent ${producerRun.node} failed, so nothing was saved`));
        continue;
      }
      if (!text) {
        results.push(notSaved(base, `the agent ${producerRun.node} produced no result`));
        continue;
      }
      // The hold rule, asked the way the engine asks it for an agent's own call.
      if (mode === 'run' && holdDecisionFor(sys.safetyPreset, WRITE_TOOL[o.kind]).held) {
        results.push(notSaved(base, 'this team is read-only, so a run writes nothing by itself — save it yourself with “Save now”, or raise “What this team is allowed to do”', 'by-hand'));
        continue;
      }
      let attempt: Attempt;
      try {
        attempt = o.kind === 'files' ? await saveFile(input, o, text, producerId)
          : o.kind === 'knowledge' ? await saveNote(input, o, text, producerId)
          : await saveTable(input, o, text);
      } catch (e) {
        attempt = { ok: false, state: 'failed', reason: e instanceof Error ? e.message : String(e), retry: 'again' };
      }
      if (!attempt.ok) {
        results.push({ ...base, state: attempt.state, reason: attempt.reason, ...(attempt.retry ? { retry: attempt.retry } : {}), message: `Not saved: ${attempt.reason}` });
        continue;
      }
      saved = attempt.saved;
    }

    // A Domain target: the item is in My; sharing it is a request a domain admin decides.
    if (o.folder.scope === 'domain' && promotion?.state !== 'requested' && promotion?.state !== 'shared') {
      try {
        promotion = await requestPromotion(input.dispatch, o.kind, saved.id);
      } catch (e) {
        promotion = { state: 'not_requested', reason: e instanceof Error ? e.message : String(e) };
      }
    }
    results.push({
      ...base,
      state: 'saved',
      id: saved.id,
      item: saved.item,
      link: linkTo(o.kind, saved.id),
      ...(typeof saved.rows === 'number' ? { rows: saved.rows } : {}),
      ...(promotion ? { promotion } : {}),
      ...(promotion?.state === 'not_requested' ? { retry: 'again' as const } : {}),
      message: before?.state === 'saved' && promotion === before.promotion ? before.message : savedMessage(base, saved, promotion),
    });
  }
  return results;
}

/** The entries a finished run shows before the save has run — the crash-window marker. */
export function pendingOutputs(sys: System): OutputResult[] {
  return (sys.outputs ?? []).map((o, index) => ({
    key: outputKey(o), index, kind: o.kind, name: o.name.trim(),
    target: { scope: o.folder.scope, path: normaliseFolderPath(o.folder.path) },
    state: 'pending' as const, retry: 'again' as const, message: 'Saving…',
  }));
}

/** The outputs a FINISHED run did not save. */
export function unsavedOutputs(results: OutputResult[] | undefined): OutputResult[] {
  return (results ?? []).filter((r) => r.state === 'failed' || r.state === 'not_saved');
}

/** The warning line a run with unsaved outputs carries, or null. */
export function unsavedOutputsWarning(results: OutputResult[] | undefined): string | null {
  const list = unsavedOutputs(results);
  if (list.length === 0) return null;
  return `Completed with unsaved outputs — ${list.map((r) => `“${r.name}”: ${r.reason ?? 'not saved'}`).join('; ')}`;
}
