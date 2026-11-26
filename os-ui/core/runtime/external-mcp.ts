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
 *   - Every remote call (run, refused, or parked for confirmation) is ONE governed trace, written
 *     here and nowhere else (the source does not trace): the acting user and whose credential ran it
 *     (`ConnectionAttribution` — the connection's credential mode; a per-user call names the subject
 *     the source reports), with secrets redacted from the arguments and from any error text.
 */
import { opaDecide } from '@core/adapters/opa/client';
import type { CurrentUser } from '@core/kernel/auth';
import type { ToolExecutor, ToolSpec } from '@core/runtime/agentic';
import type { TraceEvent } from '@core/infra/agent-governed';
import { connectionAttribution, type ConnectionAttribution, type CredentialMode } from '@core/infra/connection-attribution';
import { redactSecrets, redactSecretText } from '@core/infra/trace-masking';

/** OPA data path of `package os.external_mcp`, rule `decision` (an OPA path, not a repository path). */
export const EXTERNAL_DECISION_PATH = ['os', 'external_mcp', 'decision'].join('/');
export const PREVIEW_TOOL = 'preview_external_pages';
export const IMPORT_TOOL = 'import_external_pages';
/** Read: a spreadsheet of an account connection (sheets, columns, first rows). */
export const PREVIEW_TABLE_TOOL = 'preview_external_table';
/** Write: a spreadsheet of an account connection becomes a dataset in My data. */
export const IMPORT_TABLE_TOOL = 'import_external_table';
/** The CSV one table import may carry (the governed `ingest_dataset` in-band limit). */
export const TABLE_IMPORT_MAX_BYTES = 2 * 1024 * 1024;
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
  | 'needs_connect'
  | 'tool_error'
  | 'too_large'
  | 'rate_limited'
  | 'outcome_unknown'
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

/** Parse JSON text; a typed failure (not an empty value) when it is not JSON. */
function parseJson<T>(text: string): { ok: true; value: T } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch {
    return { ok: false };
  }
}

const errorText = (t: TypedError): string => JSON.stringify({ error: t });

// ------------------------------------------------------------------ the source port ---

export type ExternalConnection = {
  id: string;
  name: string;
  /** Short lower-case provider key, e.g. `notion`. Part of the tool name. */
  provider: string;
  owner: string;
  /** The connection's governed principal (traces are keyed by it); the id when the source has none. */
  principal?: string;
  /** Whose credential the source uses: `per_user` (the caller's own sign-in), `shared`, absent = the owner's. */
  credentialMode?: CredentialMode;
  domain: string;
  visibility: string;
  auth: string;
  archived: boolean;
  /** The source can read spreadsheets (`readTable`), so the table tools are offered for it. */
  tables?: boolean;
};

export type ExternalToolDef = {
  /** The remote server's own tool name. */
  name: string;
  description: string;
  inputSchema: ToolSpec['inputSchema'];
  /** The tool only reads (server annotation, or the reviewed read list of the provider). */
  readOnly: boolean;
};

export type ExternalCallResult = {
  text: string;
  structured?: unknown;
  isError: boolean;
  /** The credential's subject the source actually used (a per-user account), for the audit trace. */
  credentialSubject?: string;
  /**
   * What a WRITE did, for the audit trace only (e.g. `{ action: 'mail_send', sentAs: '<UPN>' }`). Never a
   * token; merged into the trace's output, not shown to the model.
   */
  audit?: Record<string, unknown>;
};

/** A spreadsheet read from an account connection, already as CSV (header row first). */
export type ExternalTable = {
  fileName: string;
  fileId: string;
  url: string;
  sheet: string;
  sheetNames: string[];
  columns: string[];
  /** The CSV, cut on a row boundary at `maxBytes`. */
  csv: string;
  /** Data rows in `csv`, and in the sheet. */
  rows: number;
  totalRows: number;
  truncated: boolean;
  preview: string[][];
};

/**
 * What the Connections tab provides. Every method is scoped to `user`: it lists only connections
 * that user can see, and it resolves the token server-side. Failures are thrown as `ExternalMcpError`.
 */
export type ExternalMcpSource = {
  listConnections(user: CurrentUser): Promise<ExternalConnection[]>;
  listTools(user: CurrentUser, connectionId: string): Promise<ExternalToolDef[]>;
  call(user: CurrentUser, connectionId: string, tool: string, args: Record<string, unknown>): Promise<ExternalCallResult>;
  /** Read a spreadsheet as CSV (account connections only). */
  readTable?(user: CurrentUser, connectionId: string, input: { fileId: string; driveId?: string; sheet?: string; headerRow?: number; maxBytes: number }): Promise<ExternalTable>;
  /**
   * Check a WRITE before it is parked for confirmation or run: the arguments (validated locally) and
   * whether the user's own sign-in grants it. Throws a typed `ExternalMcpError` (`invalid_request`,
   * `needs_connect`, …); never calls the vendor's API. So the user is never asked to confirm a call that
   * cannot run. It may read (never write) the vendor to name what the card is about, returned as
   * display-only `context` (e.g. the thread a reply goes to).
   */
  precheck?(user: CurrentUser, connectionId: string, tool: string, args: Record<string, unknown>): Promise<void | { context?: Record<string, unknown> }>;
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

/** Where a remote call's governed trace goes (the agent trace by default; injected by tests). */
export type TraceFn = (event: TraceEvent) => Promise<unknown>;

export type ExternalDeps = { source?: ExternalMcpSource | null; decide?: DecideFn; trace?: TraceFn };

const liveTrace: TraceFn = async (event) => {
  const { trace } = await import('@core/infra/agent-governed');
  return trace(event);
};

/** Who an external call acts for and whose credential it uses (`subject`: what the source reported). */
export function externalAttribution(user: CurrentUser, c: ExternalConnection, subject?: string): ConnectionAttribution {
  return connectionAttribution(c, user.id, { subject });
}

const DENY_TEXT: Record<string, { reason: string; hint: string }> = {
  connection_not_visible: { reason: 'That connection is not yours to use.', hint: 'Use a connection you can see in the Connections tab.' },
  token_belongs_to_owner: { reason: 'This connection runs on its owner\'s own sign-in, so only its owner can use it from the chat.', hint: 'Connect your own account in the Connections tab.' },
  shared_credential_not_allowed: { reason: 'A Personal connection cannot share its credential.', hint: 'Ask the owner to switch it to per-user sign-in.' },
  archived: { reason: 'That connection is archived.', hint: 'Restore it in the Connections tab first.' },
  policy_unreachable: { reason: 'The policy service did not answer, so the call was not made.', hint: 'Try again in a moment.' },
};

function decisionInput(user: CurrentUser, c: ExternalConnection, tool: string, readOnly: boolean, confirmed: boolean) {
  return {
    user: { id: user.id, domains: user.domains },
    connection: { id: c.id, owner: c.owner, domain: c.domain, visibility: c.visibility, auth: c.auth, archived: c.archived, ...(c.credentialMode ? { credential_mode: c.credentialMode } : {}) },
    tool,
    read_only: readOnly,
    confirmed,
  };
}

/**
 * OPA's answer for a READ-ONLY use of a connection outside a chat turn (the Connections "Test"): the
 * same decision path and input the chat uses. A deny carries the plain reason and hint.
 */
export async function decideExternalRead(
  user: CurrentUser,
  c: ExternalConnection,
  tool: string,
  decide: DecideFn = opaDecision,
): Promise<Decision & { text?: { reason: string; hint: string } }> {
  const d = await decide(decisionInput(user, c, tool, true, false));
  if (d.effect !== 'deny') return d;
  return { ...d, text: DENY_TEXT[d.reason] ?? { reason: `Policy refused this (${d.reason}).`, hint: 'Ask a domain admin if you need it.' } };
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
  if (out.any) {
    out.specs.push(...importToolSpecs());
    if (conns.some((c) => c.tables)) out.specs.push(...tableToolSpecs());
  }
  return out;
}

/** The OS write tools the chat needs to save what it extracted (offered up front when a source is in use). */
export const EXTRACT_WRITE_TOOLS: readonly string[] = ['save_knowledge_note'];

function tableToolSpecs(): ToolSpec[] {
  const target = {
    connectionId: { type: 'string', description: 'The connection id (the middle part of the external tool names).' },
    fileId: { type: 'string', description: 'The file id from files_search / files_list (itemId on Microsoft).' },
    driveId: { type: 'string', description: 'Microsoft only: the driveId of a SharePoint or shared file.' },
    sheet: { type: 'string', description: 'Sheet name; default the first sheet.' },
    headerRow: { type: 'number', description: '1-based row that holds the column names; default the first non-empty row.' },
  };
  return [
    {
      name: PREVIEW_TABLE_TOOL,
      description: 'Look at a spreadsheet (.xlsx, .csv or a Google Sheet) in an account connection before importing it: sheet names, the detected header, the first rows and the row count. Read-only. Nothing is saved.',
      inputSchema: { type: 'object', properties: target, required: ['connectionId', 'fileId'] },
    },
    {
      name: IMPORT_TABLE_TOOL,
      description: `Create a dataset in the user's My data from one sheet of a spreadsheet in an account connection: create_dataset, then the governed ingest (Bronze), then documentation with the source (connection, file, link, sheet, imported by/at). One confirmation covers it. At most ${TABLE_IMPORT_MAX_BYTES / 1048576} MB of CSV; a larger sheet is cut on a row boundary and the result says so.`,
      inputSchema: {
        type: 'object',
        properties: { ...target, datasetName: { type: 'string', description: 'Name of the new dataset, e.g. "Budget 2026".' }, folder: { type: 'string', description: 'Optional folder in My data.' } },
        required: ['connectionId', 'fileId', 'datasetName'],
      },
    },
  ];
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
  if (x.any) {
    lines.push(
      'Account connections (Microsoft 365, OneDrive, Google Drive, Notion) run on the USER\'S OWN sign-in. If a call answers needs_connect,',
      'tell the user to click the "Connect your account" button shown under your answer; do not retry until they have.',
      'SAVE AS KNOWLEDGE (e.g. key decisions from emails): read the items, then call save_knowledge_note ONCE per note with a markdown body',
      'that starts with a frontmatter block naming the source (source, connection, message_id or file id, subject/title, date, link) — copy',
      'the `provenance` a tool returns. Default folder: what the user said, else /imports/<provider>. The user confirms the save.',
      'SPREADSHEET → DATASET: call preview_external_table, show the user the sheet, header and row count, then call import_external_table ONCE',
      '(the user confirms). It lands in the user\'s own My data. Report the dataset and any truncation honestly.',
    );
    if (x.specs.some((s) => /__mail_(draft|send)$/.test(s.name))) {
      lines.push(
        'MAIL (only where mail_draft / mail_send are offered): write plain text, no attachments, at most 10 recipients. Prefer mail_draft',
        'unless the user clearly asked to send. Pass replyToMessageId (from mail_search) to reply in the thread. The user sees the full',
        'message (To, Cc, Subject, Body) on the confirm card and decides; say it is waiting for them, never that it was sent or drafted',
        'before the result says so. It is sent as the user, from their own mailbox.',
      );
    }
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
    if (!def) {
      // Name the valid tools, so the model corrects itself in ONE step instead of guessing again.
      const valid = defs.map((t) => wireName(conn.provider, conn.id, t.name));
      const shown = valid.slice(0, 40).join(', ');
      throw new ExternalMcpError(
        'unknown_tool',
        `"${conn.name}" has no tool "${tool}".`,
        `Call one of these exact tool names: ${shown}${valid.length > 40 ? ` (and ${valid.length - 40} more)` : ''}.`,
      );
    }
  }
  return { source, decide, conn, def };
}

/** Failure text a remote tool returned, mapped to a typed error (Notion: `object_not_found` is a permissions signal). */
function remoteFailure(text: string): ExternalMcpError {
  if (/object_not_found|restricted_resource|unauthorized|forbidden|permission|no access/i.test(text)) {
    return new ExternalMcpError('no_access', 'Your account has no access to that page or it does not exist.', 'Ask the page owner to share it with you, or pick another page.');
  }
  // The remote text goes to the chat and the model: secret-scrubbed first (a service can echo a token).
  return new ExternalMcpError('tool_error', `The service refused the call: ${redactSecretText(text.slice(0, 300))}`, 'Adjust the request and try again.');
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
  // One governed trace per call — who acted, whose credential, the decision — never the token, and
  // secret-named args redacted. A trace failure never changes the call's outcome.
  const traceFn = opts.trace ?? liveTrace;
  const record = (decision: TraceEvent['decision'], output: unknown, subject?: string) =>
    traceFn({
      ...externalAttribution(user, conn, subject),
      principal: conn.principal ?? conn.id,
      tool: `${conn.provider}.${tool}`,
      input: { args: redactSecrets(args), confirmed: opts.confirmed === true },
      output,
      decision,
    }).catch((e: unknown) => console.warn(`[external-mcp] audit trace of ${conn.provider}.${tool} was not written: ${(e as Error).message}`));
  if (d.effect === 'deny') {
    await record('deny', { denied: d.reason });
    const t = DENY_TEXT[d.reason] ?? { reason: `Policy refused this call (${d.reason}).`, hint: 'Ask a domain admin if you need it.' };
    throw new ExternalMcpError(d.reason === 'policy_unreachable' ? 'policy_unreachable' : 'policy_denied', t.reason, t.hint);
  }
  if (!def!.readOnly && source.precheck) {
    try {
      await source.precheck(user, conn.id, tool, args);
    } catch (e) {
      const t = typedOf(e);
      await record('error', { refused: t.code, error: redactSecretText(t.reason) });
      throw e instanceof ExternalMcpError ? new ExternalMcpError(e.code, redactSecretText(e.message), redactSecretText(e.hint)) : new ExternalMcpError('tool_error', redactSecretText(t.reason), t.hint);
    }
  }
  if (d.effect === 'requires_approval') {
    await record('requires_approval', { held: 'needs_confirmation' });
    throw new ExternalMcpError('needs_confirmation', `"${tool}" changes data in ${conn.provider}; it was NOT run.`, 'The user must confirm it on the confirm card first.');
  }
  let res: ExternalCallResult;
  try {
    res = await source.call(user, conn.id, tool, args);
  } catch (e) {
    const message = redactSecretText((e as Error).message ?? String(e));
    await record('error', { error: message });
    // Re-thrown to the chat/model: the same failure, its text secret-scrubbed.
    if (e instanceof ExternalMcpError) throw new ExternalMcpError(e.code, message, redactSecretText(e.hint));
    const scrubbed = new Error(message);
    scrubbed.name = (e as Error).name ?? 'Error';
    throw scrubbed;
  }
  await record(
    res.isError ? 'error' : 'allow',
    res.isError ? { error: redactSecretText(res.text.slice(0, 300)) } : { ok: true, chars: res.text.length, ...(res.audit ? redactSecrets(res.audit) as Record<string, unknown> : {}) },
    res.credentialSubject,
  );
  if (res.isError) throw remoteFailure(res.text);
  return res;
}

/**
 * The confirm gate's question for an external tool: does THIS call run without a card?
 * `free`: run it (a read, a preview, or a call the inner executor will refuse with a typed error);
 * `confirm`: park it; null: not an external tool, the gate's own rule applies.
 */
export function externalClassifier(user: CurrentUser, deps: ExternalDeps = {}): (tool: string, args?: Record<string, unknown>) => Promise<'free' | 'confirm' | null | { confirm: true; context: Record<string, unknown> }> {
  return async (tool, args = {}) => {
    if (tool === PREVIEW_TOOL || tool === PREVIEW_TABLE_TOOL) return 'free';
    const w = parseWire(tool);
    if (!w) return null;
    try {
      const { source, decide, conn, def } = await resolve(user, w.connectionId, w.tool, deps);
      const d = await decide(decisionInput(user, conn, w.tool, def!.readOnly, false));
      if (d.effect !== 'requires_approval') return 'free';
      // A write that cannot run (bad input, a sign-in without the permission) is not parked: the executor
      // refuses it at once with the typed reason, so the user is never asked to confirm a dead call.
      const pre = source.precheck ? await source.precheck(user, conn.id, w.tool, args) : undefined;
      return pre && pre.context ? { confirm: true, context: pre.context } : 'confirm';
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
    const folder = str(args.folder).trim() || ['', 'imports', conn.provider].join('/');
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
          const parsedErr = parseJson<{ error?: TypedError }>(saved.text);
          if (parsedErr.ok && parsedErr.value.error?.code) {
            const e = parsedErr.value.error;
            t = { code: e.code, reason: e.reason, hint: e.hint ?? '' };
          }
          throw new ExternalMcpError(t.code as ExternalErrorCode, t.reason, t.hint);
        }
        const parsedOut = parseJson<{ id?: string; updated?: boolean; already?: boolean }>(saved.text);
        if (!parsedOut.ok) throw new ExternalMcpError('tool_error', 'The knowledge tool answered with something unreadable, so the note may not be saved.', 'Check My knowledge, then try again.');
        const out = parsedOut.value;
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
    if (name === PREVIEW_TABLE_TOOL) return previewExternalTable(user, args, opts);
    if (name === IMPORT_TABLE_TOOL) return importExternalTable(user, args, inner, opts);
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

// ------------------------------------------------------------------ spreadsheet → dataset ---

async function readTableGoverned(user: CurrentUser, args: Record<string, unknown>, maxBytes: number, deps: ExternalDeps) {
  const connectionId = str(args.connectionId).trim();
  const fileId = str(args.fileId).trim();
  if (!connectionId || !fileId) throw new ExternalMcpError('invalid_request', 'A table needs a connectionId and a fileId.', 'Find the file with files_search first.');
  const { source, decide, conn } = await resolve(user, connectionId, null, deps);
  if (!source.readTable || !conn.tables) throw new ExternalMcpError('unknown_tool', `"${conn.name}" cannot read spreadsheets.`, 'Use a Microsoft 365, OneDrive or Google Drive connection.');
  const d = await decide(decisionInput(user, conn, 'read_table', true, false));
  if (d.effect === 'deny') {
    const t = DENY_TEXT[d.reason] ?? { reason: `Policy refused this call (${d.reason}).`, hint: 'Ask a domain admin if you need it.' };
    throw new ExternalMcpError(d.reason === 'policy_unreachable' ? 'policy_unreachable' : 'policy_denied', t.reason, t.hint);
  }
  const headerRow = Number(args.headerRow) > 0 ? Math.floor(Number(args.headerRow)) : undefined;
  const table = await source.readTable(user, conn.id, {
    fileId, ...(str(args.driveId) ? { driveId: str(args.driveId) } : {}), ...(str(args.sheet) ? { sheet: str(args.sheet) } : {}), ...(headerRow ? { headerRow } : {}), maxBytes,
  });
  return { conn, table };
}

export async function previewExternalTable(user: CurrentUser, args: Record<string, unknown>, deps: ExternalDeps = {}): Promise<{ text: string; isError: boolean }> {
  try {
    const { conn, table } = await readTableGoverned(user, args, TABLE_IMPORT_MAX_BYTES, deps);
    return {
      isError: false,
      text: JSON.stringify({
        connection: { id: conn.id, name: conn.name }, file: { id: table.fileId, name: table.fileName, url: table.url },
        sheet: table.sheet, sheets: table.sheetNames, columns: table.columns, preview: table.preview.slice(0, 10),
        rowsInSheet: table.totalRows, rowsImportable: table.rows,
        ...(table.truncated ? { note: `Only the first ${table.rows} of ${table.totalRows} rows fit the ${TABLE_IMPORT_MAX_BYTES / 1048576} MB import limit.` } : {}),
        next: 'Show the user the sheet, the columns and the row count, and ask for the dataset name before importing. Nothing has been saved.',
      }),
    };
  } catch (e) {
    return { isError: true, text: errorText(typedOf(e)) };
  }
}

function innerError(text: string): ExternalMcpError {
  const parsed = parseJson<{ error?: TypedError }>(text);
  if (parsed.ok && parsed.value.error?.code) return new ExternalMcpError(parsed.value.error.code as ExternalErrorCode, parsed.value.error.reason, parsed.value.error.hint ?? '');
  return new ExternalMcpError('tool_error', text.replace(/^Error:\s*/, '').slice(0, 300), 'Try again; if it keeps failing, ask an administrator.');
}

/** Find a dataset id in a governed tool's JSON answer (`{ id }`, `{ dataset: { id } }`). */
function datasetIdOf(text: string): string {
  const p = parseJson<Record<string, unknown>>(text.slice(text.indexOf('{')));
  if (!p.ok) return '';
  const v = p.value;
  return str(v.id) || (isObj(v.dataset) ? str(v.dataset.id) : '') || str(v.datasetId);
}

/**
 * Spreadsheet → dataset, a write: runs only on the confirm-execute path. Creates the dataset in the
 * user's My data, ingests the CSV through the governed ingest (the same path as an upload), and
 * documents it with its provenance. Every step is the governed tool run as the user (`save`).
 */
export async function importExternalTable(
  user: CurrentUser,
  args: Record<string, unknown>,
  save: ToolExecutor,
  deps: { confirmed?: boolean; now?: () => string } & ExternalDeps = {},
): Promise<{ text: string; isError: boolean }> {
  if (deps.confirmed !== true) {
    return { isError: true, text: errorText(typedOf(new ExternalMcpError('needs_confirmation', 'Importing a spreadsheet creates a dataset; it was NOT run.', 'The user must confirm it on the confirm card first.'))) };
  }
  try {
    const name = str(args.datasetName).trim();
    if (!name) throw new ExternalMcpError('invalid_request', 'An import needs a datasetName.', 'Ask the user what the dataset should be called.');
    const { conn, table } = await readTableGoverned(user, args, TABLE_IMPORT_MAX_BYTES, deps);
    if (table.columns.length === 0 || table.rows === 0) throw new ExternalMcpError('tool_error', `The sheet "${table.sheet}" has no data rows.`, 'Pick another sheet or header row.');
    const created = await save('create_dataset', { name, ...(str(args.folder) ? { folder: str(args.folder) } : {}) });
    if (created.isError) throw innerError(created.text);
    const datasetId = datasetIdOf(created.text);
    if (!datasetId) throw new ExternalMcpError('tool_error', 'The dataset was created but its id could not be read.', 'Open My data to find it.');
    const base = (table.fileName.replace(/\.[^.]+$/, '') || 'import').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60);
    const ingested = await save('ingest_dataset', { datasetId, content: table.csv, fileName: `${base}.csv` });
    if (ingested.isError) {
      const e = innerError(ingested.text);
      throw new ExternalMcpError(e.code, `The dataset "${name}" (${datasetId}) was created, but the data did not land: ${e.message}`, e.hint);
    }
    const at = (deps.now ?? (() => new Date().toISOString()))();
    const provenance = {
      source: conn.provider, connection: conn.id, connection_name: conn.name, file_id: table.fileId, file_name: table.fileName,
      link: table.url, sheet: table.sheet, rows: table.rows, rows_in_sheet: table.totalRows, imported_by: user.id, imported_at: at,
    };
    const description =
      `Imported from ${conn.provider} connection "${conn.name}": ${table.fileName}, sheet "${table.sheet}" (${table.url}). ` +
      `${table.rows} of ${table.totalRows} rows${table.truncated ? ` (cut at the ${TABLE_IMPORT_MAX_BYTES / 1048576} MB import limit)` : ''}. ` +
      `Imported by ${user.id} at ${at}.`;
    const documented = await save('document_dataset', { datasetId, description });
    return {
      isError: false,
      text: JSON.stringify({
        dataset: { id: datasetId, name, scope: 'My data' },
        rows: table.rows, rowsInSheet: table.totalRows, truncated: table.truncated, columns: table.columns,
        provenance,
        ...(documented.isError ? { warning: 'The provenance description could not be written; the data landed.' } : {}),
        summary: `Dataset "${name}" created in My data from ${table.fileName} (${table.sheet}), ${table.rows} rows${table.truncated ? ', truncated' : ''}. Promote it to the domain through the normal request.`,
      }),
    };
  } catch (e) {
    return { isError: true, text: errorText(typedOf(e)) };
  }
}
