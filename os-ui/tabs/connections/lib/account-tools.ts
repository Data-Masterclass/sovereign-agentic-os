/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        connections
 * FEATURE:    The OS's own governed chat tools for Microsoft 365, OneDrive and Google Drive
 * USER STORY: As a user I want the Home chat to search my mail, calendar, Teams and files and read a
 *             document or an Excel sheet, with MY sign-in, read-only.
 * ARCHITECTURE:
 *   - Microsoft and Google run no remote MCP server a self-hosted OS can use tonight without extra
 *     tenant programmes (Work IQ needs admin-consented WorkIQ.* scopes and Copilot-credit billing;
 *     Google's Workspace MCP servers are a Developer Preview behind enrolment). So the OS exposes the
 *     vendor's documented REST APIs (Microsoft Graph v1.0, Google Drive v3) as MCP-shaped tools behind
 *     the same `ExternalMcpSource` port Notion's remote server uses. Swapping in a vendor MCP server
 *     later changes this file only.
 *   - Read-only by construction: every tool is a GET (plus Graph's POST /search/query, a read). Each
 *     def carries `readOnly: true`, OPA still decides every call.
 *   - The access token comes in per call and is used only as the bearer to the vendor, through the
 *     adapter door `core/adapters/saas-http` (GLUE-1); `fetch` is injectable for tests. Results are compact JSON, long bodies cut at `TEXT_MAX` (said so).
 *   - Office files are read with `office-extract.ts`; PDFs are not converted here (the answer says so).
 */
import { config } from '@core/kernel/config';
import type { ExternalCallResult, ExternalToolDef } from '@core/runtime/external-mcp';
import type { ConnectionTemplateKey } from '@tabs/connections/lib/schema';
import { saasRequest, failureStatus, type SaasResponse } from '@core/adapters/saas-http/client';
import { readXlsxSheet, readDocxText, parseCsv, OfficeExtractError } from '@tabs/connections/lib/office-extract';

export type AccountProvider = 'm365' | 'onedrive' | 'gdrive';
export type FetchFn = typeof fetch;

export const TEXT_MAX = 60_000;
/** The largest file the chat downloads to read or import. */
export const FILE_MAX_BYTES = 25 * 1024 * 1024;

export function accountProviderForTemplate(t: ConnectionTemplateKey): AccountProvider | null {
  if (t === 'microsoft-365') return 'm365';
  if (t === 'onedrive') return 'onedrive';
  if (t === 'gdrive') return 'gdrive';
  return null;
}

/** A vendor API failure: `remoteStatus` mirrors the HTTP status so the source maps it to a typed error. */
export class AccountApiError extends Error {
  readonly remoteStatus: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'AccountApiError';
    this.remoteStatus = status;
  }
}

const obj = (properties: Record<string, unknown>, required: string[] = []): ExternalToolDef['inputSchema'] =>
  ({ type: 'object', properties, ...(required.length ? { required } : {}) }) as ExternalToolDef['inputSchema'];
const def = (name: string, description: string, inputSchema: ExternalToolDef['inputSchema']): ExternalToolDef => ({ name, description, inputSchema, readOnly: true });

const FILE_TOOLS_MS: ExternalToolDef[] = [
  def('files_search', 'Search files the user can open in OneDrive and SharePoint by name and content. Returns id, driveId, name, size, last modified and link.', obj({ query: { type: 'string' }, limit: { type: 'number', description: 'At most 25.' } }, ['query'])),
  def('files_list', 'List a OneDrive folder (default: the root of My files).', obj({ folderId: { type: 'string' }, driveId: { type: 'string' } })),
  def('file_read', 'Read one file as text: Word (.docx), text, CSV, JSON and Markdown as text; an Excel (.xlsx) sheet as a table preview (pass sheet). PDFs and images are not converted. Pass driveId for files from SharePoint or shared drives.', obj({ itemId: { type: 'string' }, driveId: { type: 'string' }, sheet: { type: 'string' } }, ['itemId'])),
];

const M365_TOOLS: ExternalToolDef[] = [
  def('mail_search', 'Search the user\'s Outlook mailbox (KQL, e.g. "from:anna budget"). Without a query: the newest inbox messages. Returns id, subject, from, received time, preview and a link.', obj({ query: { type: 'string' }, limit: { type: 'number', description: 'At most 25.' } })),
  def('mail_get', 'Read one email as plain text with sender, recipients, date, link and a provenance block to copy into a knowledge note.', obj({ id: { type: 'string' } }, ['id'])),
  def('calendar_events', 'List the user\'s calendar events between two ISO date-times (default: today and the next 7 days).', obj({ start: { type: 'string' }, end: { type: 'string' }, limit: { type: 'number' } })),
  def('teams_chats', 'List the user\'s recent Teams chats with the last message preview.', obj({ limit: { type: 'number' } })),
  def('teams_chat_messages', 'Read recent messages of one Teams chat.', obj({ chatId: { type: 'string' }, limit: { type: 'number' } }, ['chatId'])),
  def('teams_channels', 'List the Teams the user joined and their channels.', obj({})),
  def('teams_channel_messages', 'Read recent messages of a Teams channel.', obj({ teamId: { type: 'string' }, channelId: { type: 'string' }, limit: { type: 'number' } }, ['teamId', 'channelId'])),
  ...FILE_TOOLS_MS,
];

const GDRIVE_TOOLS: ExternalToolDef[] = [
  def('files_search', 'Search the user\'s Google Drive by name and content. Returns id, name, type, size, last modified and link.', obj({ query: { type: 'string' }, limit: { type: 'number', description: 'At most 25.' } }, ['query'])),
  def('files_list', 'List a Google Drive folder (default: My Drive root).', obj({ folderId: { type: 'string' } })),
  def('file_read', 'Read one Drive file as text: Google Docs/Slides as text, a Google Sheet or an Excel (.xlsx) sheet as a table preview (pass sheet), Word (.docx), text, CSV, JSON, Markdown. PDFs and images are not converted.', obj({ fileId: { type: 'string' }, sheet: { type: 'string' } }, ['fileId'])),
];

export function accountToolDefs(p: AccountProvider): ExternalToolDef[] {
  const src = p === 'm365' ? M365_TOOLS : p === 'onedrive' ? FILE_TOOLS_MS : GDRIVE_TOOLS;
  return src.map((t) => ({ ...t }));
}

// ------------------------------------------------------------------ http ---

type Ctx = { token: string; fetchImpl?: FetchFn };

/** One vendor call through the adapter door; a failure becomes an `AccountApiError` with its HTTP status. */
async function http(ctx: Ctx, url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}, opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<SaasResponse> {
  const r = await saasRequest(url, { ...init, bearer: ctx.token, ...opts }, ctx.fetchImpl);
  if (r.ok) return r.value;
  const status = failureStatus(r);
  if (status === 413) throw new AccountApiError(413, `The file is larger than ${Math.round((opts.maxBytes ?? FILE_MAX_BYTES) / 1048576)} MB, the most the chat reads.`);
  const e = new AccountApiError(status, `The service answered ${status || r.reason}.`); // never echo the body
  if (status === 0) e.name = r.reason === 'timeout' ? 'AbortError' : 'TypeError';
  throw e;
}

function parseJsonBody(r: SaasResponse): Record<string, unknown> {
  const text = r.bytes.toString('utf8');
  if (!text.trim()) return {};
  const value: unknown = JSON.parse(text); // a non-JSON 2xx is a real failure and throws
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

const getJson = async (ctx: Ctx, url: string, headers?: Record<string, string>): Promise<Record<string, unknown>> =>
  parseJsonBody(await http(ctx, url, headers ? { headers } : {}));

const getBytes = async (ctx: Ctx, url: string): Promise<Buffer> =>
  (await http(ctx, url, {}, { timeoutMs: 30_000, maxBytes: FILE_MAX_BYTES })).bytes;

type J = Record<string, unknown>;
const s = (v: unknown): string => (typeof v === 'string' ? v : '');
const n = (v: unknown, d: number, max = 25): number => Math.max(1, Math.min(max, Number(v) || d));
const arr = (v: unknown): J[] => (Array.isArray(v) ? (v as J[]) : []);
const enc = encodeURIComponent;
const cut = (text: string): { text: string; truncated: boolean } =>
  text.length > TEXT_MAX ? { text: text.slice(0, TEXT_MAX), truncated: true } : { text, truncated: false };
const ok = (o: unknown): ExternalCallResult => ({ text: JSON.stringify(o), structured: o, isError: false });
const html2text = (h: string): string => h.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim();

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|ndjson|xml|yaml|yml|log|html?)$/i;

/** Turn downloaded bytes into what file_read returns. */
function fileContent(name: string, mime: string, buf: Buffer, sheet?: string): Record<string, unknown> {
  try {
    if (/\.xlsx$/i.test(name) || mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
      const t = readXlsxSheet(buf, { sheet, maxRows: 200 });
      return { kind: 'table', sheet: t.sheet, sheets: t.sheetNames, columns: t.columns, rows: t.rows.slice(0, 50), totalRows: t.totalRows, previewRows: Math.min(50, t.rows.length), note: 'A preview. To turn the sheet into a dataset, use import_external_table.' };
    }
    if (/\.docx$/i.test(name) || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const c = cut(readDocxText(buf));
      return { kind: 'text', text: c.text, truncated: c.truncated };
    }
  } catch (e) {
    if (e instanceof OfficeExtractError) return { kind: 'unreadable', reason: e.message };
    throw e;
  }
  if (TEXT_EXT.test(name) || mime.startsWith('text/') || mime === 'application/json') {
    const c = cut(buf.toString('utf8'));
    return { kind: 'text', text: c.text, truncated: c.truncated };
  }
  return { kind: 'unsupported', reason: `This file type (${mime || name.split('.').pop() || 'unknown'}) is not converted to text in the chat. Sync the drive to Files to index it.` };
}

// ------------------------------------------------------------------ Microsoft Graph ---

const graph = (path: string): string => `${config.graphApiBase}/v1.0${path}`;
const driveBase = (driveId?: string): string => (driveId ? `/drives/${enc(driveId)}` : '/me/drive');

function msItem(i: J): J {
  const parent = (i.parentReference ?? {}) as J;
  return {
    id: s(i.id), driveId: s(parent.driveId) || undefined, name: s(i.name), folder: i.folder ? true : undefined,
    size: typeof i.size === 'number' ? i.size : undefined, lastModified: s(i.lastModifiedDateTime), url: s(i.webUrl),
  };
}

async function msCall(ctx: Ctx, tool: string, a: J): Promise<ExternalCallResult> {
  switch (tool) {
    case 'mail_search': {
      const top = n(a.limit, 10);
      const sel = '$select=id,subject,from,receivedDateTime,bodyPreview,webLink,hasAttachments';
      const q = s(a.query).trim();
      const url = q
        ? graph(`/me/messages?$search=${enc(`"${q.replace(/"/g, '')}"`)}&$top=${top}&${sel}`)
        : graph(`/me/mailFolders/inbox/messages?$top=${top}&$orderby=receivedDateTime desc&${sel}`);
      const r = await getJson(ctx, url);
      return ok({ messages: arr(r.value).map((m) => ({ id: s(m.id), subject: s(m.subject), from: s(((m.from as J)?.emailAddress as J)?.address), received: s(m.receivedDateTime), preview: s(m.bodyPreview), url: s(m.webLink), attachments: m.hasAttachments === true })) });
    }
    case 'mail_get': {
      const id = s(a.id).trim();
      const r = await getJson(ctx, graph(`/me/messages/${enc(id)}?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,webLink,conversationId`), { prefer: 'outlook.body-content-type="text"' });
      const body = r.body as J | undefined;
      const raw = s(body?.content);
      const c = cut(s(body?.contentType).toLowerCase() === 'html' ? html2text(raw) : raw);
      const addr = (x: unknown) => arr(x).map((p) => s((p.emailAddress as J)?.address)).filter(Boolean);
      const from = s(((r.from as J)?.emailAddress as J)?.address);
      return ok({
        id: s(r.id), subject: s(r.subject), from, to: addr(r.toRecipients), cc: addr(r.ccRecipients), received: s(r.receivedDateTime), url: s(r.webLink),
        body: c.text, truncated: c.truncated,
        provenance: { source: 'microsoft-365 mail', message_id: s(r.id), subject: s(r.subject), from, date: s(r.receivedDateTime), link: s(r.webLink) },
      });
    }
    case 'calendar_events': {
      const start = s(a.start) || new Date().toISOString().slice(0, 10) + 'T00:00:00Z';
      const end = s(a.end) || new Date(Date.parse(start) + 7 * 86400_000).toISOString();
      const r = await getJson(ctx, graph(`/me/calendarView?startDateTime=${enc(start)}&endDateTime=${enc(end)}&$top=${n(a.limit, 25, 50)}&$orderby=start/dateTime&$select=id,subject,start,end,organizer,location,webLink,isOnlineMeeting`));
      return ok({ events: arr(r.value).map((e) => ({ id: s(e.id), subject: s(e.subject), start: s((e.start as J)?.dateTime), end: s((e.end as J)?.dateTime), timeZone: s((e.start as J)?.timeZone), organizer: s(((e.organizer as J)?.emailAddress as J)?.address), location: s((e.location as J)?.displayName), online: e.isOnlineMeeting === true, url: s(e.webLink) })) });
    }
    case 'teams_chats': {
      const r = await getJson(ctx, graph(`/me/chats?$top=${n(a.limit, 15, 50)}&$expand=lastMessagePreview`));
      return ok({ chats: arr(r.value).map((c) => { const lm = (c.lastMessagePreview ?? {}) as J; return { id: s(c.id), topic: s(c.topic) || s(c.chatType), last: s(((lm.body as J)?.content)).slice(0, 300), lastAt: s(lm.createdDateTime), url: s(c.webUrl) }; }) });
    }
    case 'teams_chat_messages': {
      const r = await getJson(ctx, graph(`/me/chats/${enc(s(a.chatId))}/messages?$top=${n(a.limit, 20, 50)}`));
      return ok({ messages: arr(r.value).map(teamsMsg) });
    }
    case 'teams_channels': {
      const teams = arr((await getJson(ctx, graph('/me/joinedTeams?$select=id,displayName'))).value).slice(0, 20);
      const out: J[] = [];
      for (const t of teams) {
        const ch = arr((await getJson(ctx, graph(`/teams/${enc(s(t.id))}/channels?$select=id,displayName,webUrl`))).value);
        out.push({ teamId: s(t.id), team: s(t.displayName), channels: ch.map((c) => ({ channelId: s(c.id), name: s(c.displayName), url: s(c.webUrl) })) });
      }
      return ok({ teams: out });
    }
    case 'teams_channel_messages': {
      const r = await getJson(ctx, graph(`/teams/${enc(s(a.teamId))}/channels/${enc(s(a.channelId))}/messages?$top=${n(a.limit, 20, 50)}`));
      return ok({ messages: arr(r.value).map(teamsMsg) });
    }
    case 'files_search': {
      const r = parseJsonBody(await http(ctx, graph('/search/query'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requests: [{ entityTypes: ['driveItem'], query: { queryString: s(a.query) }, from: 0, size: n(a.limit, 10) }] }),
      }));
      const hits = arr(arr(arr(r.value)[0]?.hitsContainers)[0]?.hits);
      return ok({ files: hits.map((h) => msItem((h.resource ?? {}) as J)) });
    }
    case 'files_list': {
      const folder = s(a.folderId) ? `/items/${enc(s(a.folderId))}` : '/root';
      const r = await getJson(ctx, graph(`${driveBase(s(a.driveId) || undefined)}${folder}/children?$top=100&$select=id,name,size,folder,file,lastModifiedDateTime,webUrl,parentReference`));
      return ok({ items: arr(r.value).map(msItem) });
    }
    case 'file_read': {
      const base = `${driveBase(s(a.driveId) || undefined)}/items/${enc(s(a.itemId))}`;
      const meta = await getJson(ctx, graph(`${base}?$select=id,name,size,file,webUrl,lastModifiedDateTime,parentReference`));
      const mime = s((meta.file as J)?.mimeType);
      if (typeof meta.size === 'number' && meta.size > FILE_MAX_BYTES) throw new AccountApiError(413, `The file is ${Math.round(meta.size / 1048576)} MB; the chat reads files up to ${FILE_MAX_BYTES / 1048576} MB.`);
      const buf = await getBytes(ctx, graph(`${base}/content`));
      return ok({ file: msItem(meta), ...fileContent(s(meta.name), mime, buf, s(a.sheet) || undefined) });
    }
    default:
      throw new AccountApiError(400, `Unknown tool ${tool}.`);
  }
}

function teamsMsg(m: J): J {
  const body = (m.body ?? {}) as J;
  const text = s(body.contentType) === 'html' ? html2text(s(body.content)) : s(body.content);
  return { id: s(m.id), from: s(((m.from as J)?.user as J)?.displayName), at: s(m.createdDateTime), text: text.slice(0, 4000), url: s(m.webUrl) };
}

// ------------------------------------------------------------------ Google Drive ---

const gapi = (path: string): string => `${config.googleApiBase}/drive/v3${path}`;
const G_FIELDS = 'id,name,mimeType,size,modifiedTime,webViewLink';
const GOOGLE_EXPORT: Record<string, { mime: string; kind: 'text' | 'csv' }> = {
  'application/vnd.google-apps.document': { mime: 'text/plain', kind: 'text' },
  'application/vnd.google-apps.presentation': { mime: 'text/plain', kind: 'text' },
  'application/vnd.google-apps.spreadsheet': { mime: 'text/csv', kind: 'csv' },
};

function gItem(f: J): J {
  return { id: s(f.id), name: s(f.name), mimeType: s(f.mimeType), size: f.size ? Number(f.size) : undefined, lastModified: s(f.modifiedTime), url: s(f.webViewLink) };
}

async function gCall(ctx: Ctx, tool: string, a: J): Promise<ExternalCallResult> {
  switch (tool) {
    case 'files_search': {
      const q = `fullText contains '${s(a.query).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' and trashed = false`;
      const r = await getJson(ctx, gapi(`/files?q=${enc(q)}&pageSize=${n(a.limit, 10)}&fields=${enc(`files(${G_FIELDS})`)}&supportsAllDrives=true&includeItemsFromAllDrives=true`));
      return ok({ files: arr(r.files).map(gItem) });
    }
    case 'files_list': {
      const parent = s(a.folderId) || 'root';
      const q = `'${parent.replace(/'/g, "\\'")}' in parents and trashed = false`;
      const r = await getJson(ctx, gapi(`/files?q=${enc(q)}&pageSize=100&fields=${enc(`files(${G_FIELDS})`)}&supportsAllDrives=true&includeItemsFromAllDrives=true`));
      return ok({ items: arr(r.files).map(gItem) });
    }
    case 'file_read': {
      const id = enc(s(a.fileId));
      const meta = await getJson(ctx, gapi(`/files/${id}?fields=${enc(G_FIELDS)}&supportsAllDrives=true`));
      const mime = s(meta.mimeType);
      const exp = GOOGLE_EXPORT[mime];
      if (exp) {
        const buf = await getBytes(ctx, gapi(`/files/${id}/export?mimeType=${enc(exp.mime)}`));
        if (exp.kind === 'csv') {
          const t = parseCsv(buf.toString('utf8'), 200);
          return ok({ file: gItem(meta), kind: 'table', sheet: '(first sheet)', columns: t.columns, rows: t.rows.slice(0, 50), totalRows: t.totalRows, note: 'Google exports only the first sheet of a Google Sheet. To turn it into a dataset, use import_external_table.' });
        }
        const c = cut(buf.toString('utf8'));
        return ok({ file: gItem(meta), kind: 'text', text: c.text, truncated: c.truncated });
      }
      if (mime.startsWith('application/vnd.google-apps.')) return ok({ file: gItem(meta), kind: 'unsupported', reason: `Google ${mime.split('.').pop()} files cannot be read as text.` });
      if (meta.size && Number(meta.size) > FILE_MAX_BYTES) throw new AccountApiError(413, `The file is ${Math.round(Number(meta.size) / 1048576)} MB; the chat reads files up to ${FILE_MAX_BYTES / 1048576} MB.`);
      const buf = await getBytes(ctx, gapi(`/files/${id}?alt=media&supportsAllDrives=true`));
      return ok({ file: gItem(meta), ...fileContent(s(meta.name), mime, buf, s(a.sheet) || undefined) });
    }
    default:
      throw new AccountApiError(400, `Unknown tool ${tool}.`);
  }
}

/** Run one account tool with the user's access token. Throws `AccountApiError` on a vendor failure. */
export async function callAccountTool(p: AccountProvider, token: string, tool: string, args: Record<string, unknown>, opts: { fetchImpl?: FetchFn } = {}): Promise<ExternalCallResult> {
  if (!accountToolDefs(p).some((t) => t.name === tool)) throw new AccountApiError(400, `Unknown tool ${tool}.`);
  const ctx = { token, fetchImpl: opts.fetchImpl };
  return p === 'gdrive' ? gCall(ctx, tool, args) : msCall(ctx, tool, args);
}

// ------------------------------------------------------------------ table export (for the dataset import) ---

export type AccountTable = {
  fileName: string;
  fileId: string;
  url: string;
  sheet: string;
  sheetNames: string[];
  columns: string[];
  rows: string[][];
  totalRows: number;
  truncated: boolean;
};

const isSheetLike = (name: string, mime: string): boolean =>
  /\.(xlsx|csv|tsv)$/i.test(name) || mime.includes('spreadsheetml') || mime === 'text/csv';

/** Read a spreadsheet (xlsx, csv, Google Sheet) from the account as a whole table, for an import. */
export async function readAccountTable(
  p: AccountProvider,
  token: string,
  input: { fileId: string; driveId?: string; sheet?: string; headerRow?: number; maxRows?: number },
  opts: { fetchImpl?: FetchFn } = {},
): Promise<AccountTable> {
  const ctx = { token, fetchImpl: opts.fetchImpl };
  const maxRows = input.maxRows ?? 50_000;
  let name = '';
  let url = '';
  let mime = '';
  let buf: Buffer;
  if (p === 'gdrive') {
    const id = enc(input.fileId);
    const meta = await getJson(ctx, gapi(`/files/${id}?fields=${enc(G_FIELDS)}&supportsAllDrives=true`));
    name = s(meta.name); url = s(meta.webViewLink); mime = s(meta.mimeType);
    if (mime === 'application/vnd.google-apps.spreadsheet') {
      buf = await getBytes(ctx, gapi(`/files/${id}/export?mimeType=${enc('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')}`));
      mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      name = /\.xlsx$/i.test(name) ? name : `${name}.xlsx`;
    } else {
      if (!isSheetLike(name, mime)) throw new OfficeExtractError(`"${name}" is not a spreadsheet (.xlsx, .csv or a Google Sheet).`);
      if (meta.size && Number(meta.size) > FILE_MAX_BYTES) throw new AccountApiError(413, `The file is ${Math.round(Number(meta.size) / 1048576)} MB; imports take files up to ${FILE_MAX_BYTES / 1048576} MB.`);
      buf = await getBytes(ctx, gapi(`/files/${id}?alt=media&supportsAllDrives=true`));
    }
  } else {
    const base = `${driveBase(input.driveId)}/items/${enc(input.fileId)}`;
    const meta = await getJson(ctx, graph(`${base}?$select=id,name,size,file,webUrl`));
    name = s(meta.name); url = s(meta.webUrl); mime = s((meta.file as J)?.mimeType);
    if (!isSheetLike(name, mime)) throw new OfficeExtractError(`"${name}" is not a spreadsheet (.xlsx or .csv).`);
    if (typeof meta.size === 'number' && meta.size > FILE_MAX_BYTES) throw new AccountApiError(413, `The file is ${Math.round(meta.size / 1048576)} MB; imports take files up to ${FILE_MAX_BYTES / 1048576} MB.`);
    buf = await getBytes(ctx, graph(`${base}/content`));
  }
  if (/\.xlsx$/i.test(name) || mime.includes('spreadsheetml')) {
    const t = readXlsxSheet(buf, { sheet: input.sheet, headerRow: input.headerRow, maxRows });
    return { fileName: name, fileId: input.fileId, url, sheet: t.sheet, sheetNames: t.sheetNames, columns: t.columns, rows: t.rows, totalRows: t.totalRows, truncated: t.truncated };
  }
  if (/\.(csv|tsv)$/i.test(name) || mime === 'text/csv') {
    const t = parseCsv(buf.toString('utf8'), maxRows);
    return { fileName: name, fileId: input.fileId, url, sheet: '(csv)', sheetNames: [], columns: t.columns, rows: t.rows, totalRows: t.totalRows, truncated: t.truncated };
  }
  throw new OfficeExtractError(`"${name}" is not a spreadsheet (.xlsx, .csv or a Google Sheet).`);
}
