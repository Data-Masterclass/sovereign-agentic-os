/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    External MCP tools in the Home chat, and "copy these pages into knowledge" on request
 * USER STORY: As a user I want the chat to search and read my Notion (and later other remote MCP
 *             connections) as me, and to copy the pages I pick into My knowledge, with every call
 *             checked by OPA and every write behind my confirmation.
 * ARCHITECTURE:
 *   - The kernel owns the contract (`ExternalMcpSource`); the Connections tab registers the one
 *     implementation (`tabs/connections/lib/external-mcp-source.ts`), so the kernel never imports a tab.
 *     The source holds the OAuth token; it never reaches the model, the client or this module.
 *   - Tool names are `<provider>__<connectionId>__<remote tool>` (OpenAI-compatible tool names cannot
 *     contain `:`). The remote tool name is kept as the server advertises it.
 *   - OPA (`os/external_mcp/decision`, chart policy `external_mcp.rego`) decides every call. An
 *     unreachable OPA is a refusal. A read runs; a write is parked by the confirm gate (`classify`)
 *     and runs only after the same user confirmed it, when OPA is asked again with `confirmed`.
 *   - Import: `preview_external_pages` (read) lists pages with title, link, size, last edited.
 *     `import_external_pages` is a write: ONE confirm card covers the selection. Each page is saved
 *     by the governed `save_knowledge_note` (My scope), keyed `notion:<connection>:<page>` so a
 *     re-import updates the same note. Workflows are never written here.
 */
import { opaDecide } from '@core/adapters/opa/client';
import type { CurrentUser } from '@core/kernel/auth';
import type { ToolExecutor, ToolSpec } from '@core/runtime/agentic';

export const EXTERNAL_DECISION_PATH = 'os/external_mcp/decision';
export const PREVIEW_TOOL = 'preview_external_pages';
export const IMPORT_TOOL = 'import_external_pages';
/** Pages one import may take, and the size of one note (the same cap `save_knowledge_note` enforces). */
export const IMPORT_MAX_PAGES = 25;
export const NOTE_MAX_BYTES = 512 * 1024;
export const PREVIEW_MAX_PAGES = 10;
const MAX_TOOL_NAME = 64;

// ------------------------------------------------------------------ typed errors ---

export type ExternalErrorCode =
  | 'oauth_expired'
  | 'mcp_unreachable'
  | 'no_access'
  | 'policy_denied'
  | 'policy_unreachable'
  | 'unknown_connection'
  | 'unknown_tool'
  | 'needs_confirmation'
  | 'tool_error'
  | 'too_large'
  | 'invalid_request';

/** A plain-language, typed failure: the same `{ code, reason, hint }` shape every governed tool error has. */
export class ExternalMcpError extends Error {
  readonly code: ExternalErrorCode;
  readonly hint: string;
  constructor(code: ExternalErrorCode, reason: string, hint: string) {
    super(reason);
    this.name = 'ExternalMcpError';
    this.code = code;
    this.hint = hint;
  }
}

export type TypedError = { code: string; reason: string; hint: string };

export function typedOf(e: unknown): TypedError {
  if (e instanceof ExternalMcpError) return { code: e.code, reason: e.message, hint: e.hint };
  return { code: 'tool_error', reason: (e as Error)?.message ?? String(e), hint: 'Try again; if it keeps failing, ask an administrator.' };
}

const errorText = (t: TypedError): string => JSON.stringify({ error: t });

// ------------------------------------------------------------------ the source port ---

export type ExternalConnection = {
  id: string;
  name: string;
  /** Short lower-case provider key, e.g. `notion`. Part of the tool name. */
  provider: string;
  owner: string;
  domain: string;
  visibility: string;
  auth: string;
  archived: boolean;
};

export type ExternalToolDef = {
  /** The remote server's own tool name. */
  name: string;
  description: string;
  inputSchema: ToolSpec['inputSchema'];
  /** The tool only reads (server annotation, or the reviewed read list of the provider). */
  readOnly: boolean;
};

export type ExternalCallResult = { text: string; structured?: unknown; isError: boolean };

/**
 * What the Connections tab provides. Every method is scoped to `user`: it lists only connections
 * that user can see, and it resolves the token server-side. Failures are thrown as `ExternalMcpError`.
 */
export type ExternalMcpSource = {
  listConnections(user: CurrentUser): Promise<ExternalConnection[]>;
  listTools(user: CurrentUser, connectionId: string): Promise<ExternalToolDef[]>;
  call(user: CurrentUser, connectionId: string, tool: string, args: Record<string, unknown>): Promise<ExternalCallResult>;
};

let registered: ExternalMcpSource | null = null;
export function registerExternalMcpSource(s: ExternalMcpSource | null): void {
  registered = s;
}
export function getExternalMcpSource(): ExternalMcpSource | null {
  return registered;
}

// ------------------------------------------------------------------ tool names ---

export function wireName(provider: string, connectionId: string, tool: string): string {
  return `${provider}__${connectionId}__${tool}`;
}

export function parseWire(name: string): { provider: string; connectionId: string; tool: string } | null {
  const m = /^([a-z][a-z0-9]*)__([A-Za-z0-9_-]+?)__([A-Za-z0-9_.-]+)$/.exec(name);
  return m ? { provider: m[1], connectionId: m[2], tool: m[3] } : null;
}

// ------------------------------------------------------------------ OPA ---

export type Effect = 'allow' | 'requires_approval' | 'deny';
export type Decision = { effect: Effect; reason: string };
export type DecideFn = (input: Record<string, unknown>) => Promise<Decision>;

/** Ask OPA. No answer, or an answer that is not an effect, is a deny. */
export const opaDecision: DecideFn = async (input) => {
  const r = await opaDecide(EXTERNAL_DECISION_PATH, input, 2500);
  if (!r.ok || !r.value.defined) return { effect: 'deny', reason: 'policy_unreachable' };
  const d = r.value.value as Partial<Decision> | undefined;
  if (d && (d.effect === 'allow' || d.effect === 'requires_approval' || d.effect === 'deny')) {
    return { effect: d.effect, reason: String(d.reason ?? '') };
  }
  return { effect: 'deny', reason: 'policy_unreachable' };
};

export type ExternalDeps = { source?: ExternalMcpSource | null; decide?: DecideFn };

const DENY_TEXT: Record<string, { reason: string; hint: string }> = {
  connection_not_visible: { reason: 'That connection is not yours to use.', hint: 'Use a connection you can see in the Connections tab.' },
  token_belongs_to_owner: { reason: 'This connection runs on its owner\'s own sign-in, so only its owner can use it from the chat.', hint: 'Connect your own account in the Connections tab.' },
  archived: { reason: 'That connection is archived.', hint: 'Restore it in the Connections tab first.' },
  policy_unreachable: { reason: 'The policy service did not answer, so the call was not made.', hint: 'Try again in a moment.' },
};

function decisionInput(user: CurrentUser, c: ExternalConnection, tool: string, readOnly: boolean, confirmed: boolean) {
  return {
    user: { id: user.id, domains: user.domains },
    connection: { id: c.id, owner: c.owner, domain: c.domain, visibility: c.visibility, auth: c.auth, archived: c.archived },
    tool,
    read_only: readOnly,
    confirmed,
  };
}

function need(deps: ExternalDeps): { source: ExternalMcpSource; decide: DecideFn } {
  const source = deps.source ?? registered;
  if (!source) throw new ExternalMcpError('unknown_connection', 'No external connections are available in this chat.', 'Connect a service in the Connections tab.');
  return { source, decide: deps.decide ?? opaDecision };
}

// ------------------------------------------------------------------ listing for a turn ---

export type ExternalTools = {
  specs: ToolSpec[];
  /** One honest line per connection or tool that could not be offered this turn. */
  notes: string[];
  /** True when the user has at least one usable external connection (the import tools are offered). */
  any: boolean;
};

export async function loadExternalTools(user: CurrentUser, deps: ExternalDeps = {}): Promise<ExternalTools> {
  const source = deps.source ?? registered;
  const out: ExternalTools = { specs: [], notes: [], any: false };
  if (!source) return out;
  const decide = deps.decide ?? opaDecision;
  let conns: ExternalConnection[];
  try {
    conns = await source.listConnections(user);
  } catch (e) {
    out.notes.push(`Your external connections could not be listed: ${typedOf(e).reason}`);
    return out;
  }
  for (const c of conns) {
    const d = await decide(decisionInput(user, c, '', true, false));
    if (d.effect === 'deny') continue; // not this user's: no tools, no note
    let tools: ExternalToolDef[];
    try {
      tools = await source.listTools(user, c.id);
    } catch (e) {
      const t = typedOf(e);
      out.notes.push(`${c.provider} connection "${c.name}" is unavailable (${t.code}): ${t.reason} ${t.hint}`.trim());
      continue;
    }
    out.any = true;
    const skipped: string[] = [];
    for (const t of tools) {
      const name = wireName(c.provider, c.id, t.name);
      if (name.length > MAX_TOOL_NAME || !parseWire(name)) {
        skipped.push(t.name);
        continue;
      }
      out.specs.push({
        name,
        description:
          `[${c.provider} connection "${c.name}", runs as you] ${t.description}` +
          (t.readOnly ? '' : ' CHANGES DATA in the external service: the user must confirm first.'),
        inputSchema: t.inputSchema,
      });
    }
    if (skipped.length) out.notes.push(`${skipped.length} ${c.provider} tool(s) of "${c.name}" are not offered because their names are too long: ${skipped.join(', ')}.`);
  }
  if (out.any) out.specs.push(...importToolSpecs());
  return out;
}

function importToolSpecs(): ToolSpec[] {
  return [
    {
      name: PREVIEW_TOOL,
      description:
        'List pages of an external connection (Notion) that match a search, with title, link, size and last-edited time, so the user can choose which to copy into My knowledge. Read-only. Nothing is saved.',
      inputSchema: {
        type: 'object',
        properties: {
          connectionId: { type: 'string', description: 'The connection id (the middle part of the external tool names).' },
          query: { type: 'string', description: 'What to search for.' },
          limit: { type: 'number', description: `How many pages to preview, at most ${PREVIEW_MAX_PAGES}.` },
        },
        required: ['connectionId', 'query'],
      },
    },
    {
      name: IMPORT_TOOL,
      description:
        `Copy the pages the user picked from an external connection into My knowledge as notes (markdown, with the source, page id, link, last edited, imported at and imported by). One confirmation covers the whole selection. A page imported before is updated, not duplicated. At most ${IMPORT_MAX_PAGES} pages and ${NOTE_MAX_BYTES / 1024} KB per page. Never creates workflows.`,
      inputSchema: {
        type: 'object',
        properties: {
          connectionId: { type: 'string' },
          pages: {
            type: 'array',
            description: 'The pages the user picked, from the preview.',
            items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } }, required: ['id'] },
          },
          folder: { type: 'string', description: 'Folder in My knowledge; default /imports/<provider>.' },
        },
        required: ['connectionId', 'pages'],
      },
    },
  ];
}

/** The prompt block for a turn that has external connections (or notes about ones that failed). */
export function externalPromptBlock(x: ExternalTools): string {
  if (!x.any && x.notes.length === 0) return '';
  const lines = ['', '--- EXTERNAL CONNECTIONS (the user\'s own, run as the user) ---'];
  if (x.any) {
    lines.push(
      'Tools named <provider>__<connectionId>__<tool> call the user\'s remote MCP connection (Notion). Reads (search, fetch) run at once.',
      'Anything that creates or changes data there is held for the user\'s confirmation card: say what it will do, never claim it was done.',
      'COPY INTO KNOWLEDGE, only when the user asks: 1) call preview_external_pages; 2) show a numbered list with title, link, size and last edited,',
      'and ask which to copy; 3) call import_external_pages ONCE with exactly the chosen pages (one confirmation covers all);',
      '4) report what was imported, what was updated and each page that failed with its reason. Large pages: say the limits plainly.',
      'Imports become knowledge notes in the user\'s own My scope; promotion to the domain is the normal request-promotion path. Never write workflows here.',
    );
  }
  for (const n of x.notes) lines.push(`NOT AVAILABLE: ${n} Tell the user plainly if they ask for it.`);
  return lines.join('\n');
}

// ------------------------------------------------------------------ one governed call ---

async function resolve(user: CurrentUser, connectionId: string, tool: string | null, deps: ExternalDeps) {
  const { source, decide } = need(deps);
  const conns = await source.listConnections(user);
  const conn = conns.find((c) => c.id === connectionId);
  if (!conn) throw new ExternalMcpError('unknown_connection', `You have no external connection "${connectionId}".`, 'Check the Connections tab.');
  let def: ExternalToolDef | null = null;
  if (tool !== null) {
    const defs = await source.listTools(user, conn.id);
    def = defs.find((t) => t.name === tool) ?? null;
    if (!def) throw new ExternalMcpError('unknown_tool', `"${conn.name}" has no tool "${tool}".`, 'Use one of the tools offered for this connection.');
  }
  return { source, decide, conn, def };
}

/** Failure text a remote tool returned, mapped to a typed error (Notion: `object_not_found` is a permissions signal). */
function remoteFailure(text: string): ExternalMcpError {
  if (/object_not_found|restricted_resource|unauthorized|forbidden|permission|no access/i.test(text)) {
    return new ExternalMcpError('no_access', 'Your account has no access to that page or it does not exist.', 'Ask the page owner to share it with you, or pick another page.');
  }
  return new ExternalMcpError('tool_error', `The service refused the call: ${text.slice(0, 300)}`, 'Adjust the request and try again.');
}

/**
 * One governed call of a remote tool as `user`: visibility, OPA, then the source. `confirmed` is set only by
 * the confirm-execute path, after this user said yes to this exact call.
 */
export async function callExternal(
  user: CurrentUser,
  connectionId: string,
  tool: string,
  args: Record<string, unknown>,
  opts: { confirmed?: boolean } & ExternalDeps = {},
): Promise<ExternalCallResult> {
  const { source, decide, conn, def } = await resolve(user, connectionId, tool, opts);
  const d = await decide(decisionInput(user, conn, tool, def!.readOnly, opts.confirmed === true));
  if (d.effect === 'deny') {
    const t = DENY_TEXT[d.reason] ?? { reason: `Policy refused this call (${d.reason}).`, hint: 'Ask a domain admin if you need it.' };
    throw new ExternalMcpError(d.reason === 'policy_unreachable' ? 'policy_unreachable' : 'policy_denied', t.reason, t.hint);
  }
  if (d.effect === 'requires_approval') {
    throw new ExternalMcpError('needs_confirmation', `"${tool}" changes data in ${conn.provider}; it was NOT run.`, 'The user must confirm it on the confirm card first.');
  }
  const res = await source.call(user, conn.id, tool, args);
  if (res.isError) throw remoteFailure(res.text);
  return res;
}

/**
 * The confirm gate's question for an external tool: does THIS call run without a card?
 * `free`: run it (a read, a preview, or a call the inner executor will refuse with a typed error);
 * `confirm`: park it; null: not an external tool, the gate's own rule applies.
 */
export function externalClassifier(user: CurrentUser, deps: ExternalDeps = {}): (tool: string) => Promise<'free' | 'confirm' | null> {
  return async (tool) => {
    if (tool === PREVIEW_TOOL) return 'free';
    const w = parseWire(tool);
    if (!w) return null;
    try {
      const { decide, conn, def } = await resolve(user, w.connectionId, w.tool, deps);
      const d = await decide(decisionInput(user, conn, w.tool, def!.readOnly, false));
      return d.effect === 'requires_approval' ? 'confirm' : 'free';
    } catch {
      return 'free'; // the executor refuses it with the typed error
    }
  };
}

// ------------------------------------------------------------------ parsing what Notion returns ---

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function asData(res: ExternalCallResult): unknown {
  if (res.structured !== undefined && res.structured !== null) return res.structured;
  try {
    return JSON.parse(res.text);
  } catch {
    return res.text;
  }
}

export type PageHit = { id: string; title: string; url: string; lastEdited: string | null };

export function parseSearchHits(res: ExternalCallResult): PageHit[] {
  const data = asData(res);
  const list = Array.isArray(data) ? data : isObj(data) && Array.isArray(data.results) ? data.results : [];
  const hits: PageHit[] = [];
  for (const r of list) {
    if (!isObj(r)) continue;
    const url = str(r.url);
    const id = str(r.id) || (/([0-9a-f]{32})\/?$/i.exec(url.replace(/-/g, ''))?.[1] ?? '');
    if (!id) continue;
    const last = str(r.timestamp) || str(r.last_edited_time) || str(r.last_edited) || str(r.updated_at) || str(r.page_last_edited_at);
    hits.push({ id, title: str(r.title) || '(untitled)', url, lastEdited: last || null });
  }
  return hits;
}

export type FetchedPage = { title: string; url: string; lastEdited: string | null; markdown: string; truncated: boolean };

/** Notion's `notion-fetch` result as a markdown note body (JSON `{title,url,text}`, or page markdown, optionally wrapped in `<content>`). */
export function parseFetchedPage(res: ExternalCallResult, fallback: { id: string; title?: string; url?: string }): FetchedPage {
  const data = asData(res);
  let title = fallback.title ?? '';
  let url = fallback.url ?? '';
  let last: string | null = null;
  let body = '';
  let truncated = false;
  if (isObj(data)) {
    title = str(data.title) || title;
    url = str(data.url) || url;
    last = str(data.page_last_edited_at) || str(data.last_edited_time) || (isObj(data.metadata) ? str(data.metadata.last_edited) : '') || null;
    body = str(data.text) || str(data.markdown) || str(data.content);
    truncated = data.truncated === true;
  } else {
    body = String(data);
  }
  const wrapped = /<content>([\s\S]*?)<\/content>/.exec(body);
  if (wrapped) body = wrapped[1];
  if (!url) url = /url="([^"]+)"/.exec(String(isObj(data) ? '' : data))?.[1] ?? '';
  body = body.replace(/<empty-block\s*\/>/g, '').trim();
  return { title: title || fallback.id, url, lastEdited: last || null, markdown: body, truncated };
}

// ------------------------------------------------------------------ preview ---

type PageProblem = TypedError & { pageId: string };

export async function previewExternalPages(
  user: CurrentUser,
  args: Record<string, unknown>,
  deps: ExternalDeps = {},
): Promise<{ text: string; isError: boolean }> {
  try {
    const connectionId = str(args.connectionId).trim();
    const query = str(args.query).trim();
    if (!connectionId || !query) throw new ExternalMcpError('invalid_request', 'A preview needs a connectionId and a query.', 'Say which connection and what to search for.');
    const limit = Math.max(1, Math.min(PREVIEW_MAX_PAGES, Number(args.limit) || PREVIEW_MAX_PAGES));
    const { conn } = await resolve(user, connectionId, 'notion-search', deps);
    const found = parseSearchHits(await callExternal(user, connectionId, 'notion-search', { query }, deps));
    const pages: Record<string, unknown>[] = [];
    let n = 0;
    for (const hit of found.slice(0, limit)) {
      n += 1;
      try {
        const page = parseFetchedPage(await callExternal(user, connectionId, 'notion-fetch', { id: hit.id }, deps), hit);
        const size = Buffer.byteLength(page.markdown, 'utf8');
        pages.push({
          n, id: hit.id, title: page.title, url: page.url || hit.url, lastEdited: page.lastEdited ?? hit.lastEdited ?? 'not reported',
          sizeBytes: size, importable: size > 0 && size <= NOTE_MAX_BYTES,
          ...(size > NOTE_MAX_BYTES ? { note: `larger than the ${NOTE_MAX_BYTES / 1024} KB note limit; it will not be imported` } : {}),
          ...(page.truncated ? { note: 'Notion returned only the first part of this page; an import would hold that part and say so' } : {}),
        });
      } catch (e) {
        pages.push({ n, id: hit.id, title: hit.title, url: hit.url, error: typedOf(e) });
      }
    }
    return {
      isError: false,
      text: JSON.stringify({
        connection: { id: conn.id, name: conn.name },
        query,
        found: found.length,
        shown: pages.length,
        pages,
        limits: `At most ${IMPORT_MAX_PAGES} pages per import and ${NOTE_MAX_BYTES / 1024} KB per page. Sizes are measured on the converted markdown.`,
        next: 'Show the user this list and ask which pages to copy. Nothing has been saved.',
      }),
    };
  } catch (e) {
    return { isError: true, text: errorText(typedOf(e)) };
  }
}

// ------------------------------------------------------------------ import ---

const q = (v: string): string => JSON.stringify(v);

/** The note body: provenance frontmatter, then the page as markdown. Pure. */
export function noteMarkdown(p: { provider: string; connectionId: string; pageId: string; page: FetchedPage; importedAt: string; importedBy: string }): string {
  const fm = [
    '---',
    `source: ${q(p.provider)}`,
    `source_connection: ${q(p.connectionId)}`,
    `source_page_id: ${q(p.pageId)}`,
    `source_url: ${q(p.page.url)}`,
    `last_edited: ${q(p.page.lastEdited ?? 'not reported')}`,
    `imported_at: ${q(p.importedAt)}`,
    `imported_by: ${q(p.importedBy)}`,
    ...(p.page.truncated ? ['truncated_by_source: true'] : []),
    '---',
    '',
  ].join('\n');
  return `${fm}${p.page.markdown}\n`;
}

export function importSourceKey(provider: string, connectionId: string, pageId: string): string {
  return `${provider}:${connectionId}:${pageId}`;
}

type Picked = { id: string; title?: string };

export async function importExternalPages(
  user: CurrentUser,
  args: Record<string, unknown>,
  save: ToolExecutor,
  deps: { confirmed?: boolean; now?: () => string } & ExternalDeps = {},
): Promise<{ text: string; isError: boolean }> {
  // A write: it runs only on the confirm-execute path, after the same user confirmed this selection.
  if (deps.confirmed !== true) {
    return { isError: true, text: errorText(typedOf(new ExternalMcpError('needs_confirmation', 'Importing pages writes knowledge notes; it was NOT run.', 'The user must confirm the selection on the confirm card first.'))) };
  }
  const imported: Record<string, unknown>[] = [];
  const failed: (PageProblem & { title?: string })[] = [];
  try {
    const connectionId = str(args.connectionId).trim();
    const pages: Picked[] = Array.isArray(args.pages)
      ? (args.pages as unknown[]).filter(isObj).map((p) => ({ id: str(p.id).trim(), title: str(p.title) || undefined })).filter((p) => p.id)
      : [];
    if (!connectionId || pages.length === 0) throw new ExternalMcpError('invalid_request', 'An import needs a connectionId and at least one page.', 'Preview first, then pick the pages.');
    if (pages.length > IMPORT_MAX_PAGES) throw new ExternalMcpError('invalid_request', `At most ${IMPORT_MAX_PAGES} pages per import; you picked ${pages.length}.`, 'Split the selection into smaller imports.');
    const { conn } = await resolve(user, connectionId, 'notion-fetch', deps);
    const folder = str(args.folder).trim() || `/imports/${conn.provider}`;
    const domain = user.activeDomain ?? user.domains[0];
    for (const pick of pages) {
      try {
        const page = parseFetchedPage(await callExternal(user, connectionId, 'notion-fetch', { id: pick.id }, deps), { id: pick.id, title: pick.title });
        const size = Buffer.byteLength(page.markdown, 'utf8');
        if (size === 0) throw new ExternalMcpError('tool_error', 'The page has no text content.', 'Pick a page with content.');
        if (size > NOTE_MAX_BYTES) throw new ExternalMcpError('too_large', `The page is ${Math.round(size / 1024)} KB; a note holds at most ${NOTE_MAX_BYTES / 1024} KB.`, 'Split the page in Notion, or save it as a file.');
        const md = noteMarkdown({ provider: conn.provider, connectionId: conn.id, pageId: pick.id, page, importedAt: (deps.now ?? (() => new Date().toISOString()))(), importedBy: user.id });
        const saved = await save('save_knowledge_note', {
          title: page.title,
          md,
          folder,
          ...(domain ? { domain } : {}),
          sourceKey: importSourceKey(conn.provider, conn.id, pick.id),
          refresh: true,
        });
        if (saved.isError) {
          let t: TypedError = { code: 'tool_error', reason: saved.text.slice(0, 300), hint: 'Try again.' };
          try {
            const e = (JSON.parse(saved.text) as { error?: TypedError }).error;
            if (e?.code) t = { code: e.code, reason: e.reason, hint: e.hint ?? '' };
          } catch { /* free text */ }
          throw new ExternalMcpError(t.code as ExternalErrorCode, t.reason, t.hint);
        }
        let out: { id?: string; updated?: boolean; already?: boolean } = {};
        try { out = JSON.parse(saved.text) as typeof out; } catch { /* leave empty */ }
        imported.push({
          pageId: pick.id, title: page.title, url: page.url, noteId: out.id, sizeBytes: size,
          action: out.updated ? 'updated' : 'created', ...(page.truncated ? { partial: 'Notion returned only the first part of the page' } : {}),
        });
      } catch (e) {
        failed.push({ pageId: pick.id, ...(pick.title ? { title: pick.title } : {}), ...typedOf(e) });
      }
    }
  } catch (e) {
    return { isError: true, text: errorText(typedOf(e)) };
  }
  const allFailed = imported.length === 0;
  return {
    isError: allFailed,
    text: JSON.stringify({
      ...(allFailed ? { error: { code: 'import_failed', reason: 'No page could be imported.', hint: 'See `failed` for each page.' } } : {}),
      imported,
      failed,
      summary: `${imported.length} imported (${imported.filter((i) => i.action === 'updated').length} updated), ${failed.length} failed. Notes are in My knowledge; promote them to the domain through the normal request.`,
    }),
  };
}

// ------------------------------------------------------------------ the executor ---

/**
 * Put the external tools in front of the governed executor: the preview, the import and the remote tools are handled here,
 * every other name goes to `inner` unchanged. `confirmed` is true only on the confirm-execute path.
 */
export function withExternalTools(user: CurrentUser, inner: ToolExecutor, opts: { confirmed?: boolean } & ExternalDeps = {}): ToolExecutor {
  return async (name, args) => {
    if (name === PREVIEW_TOOL) return previewExternalPages(user, args, opts);
    if (name === IMPORT_TOOL) return importExternalPages(user, args, inner, opts);
    const w = parseWire(name);
    if (!w) return inner(name, args);
    try {
      const res = await callExternal(user, w.connectionId, w.tool, args, opts);
      return { text: res.text || '(no output)', isError: false };
    } catch (e) {
      return { text: errorText(typedOf(e)), isError: true };
    }
  };
}
