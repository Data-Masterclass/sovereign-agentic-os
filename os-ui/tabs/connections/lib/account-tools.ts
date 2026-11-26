/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        connections
 * FEATURE:    The OS's own governed chat tools for Microsoft 365, OneDrive and Google Drive (+ approval-gated mail)
 * USER STORY: As a user I want the Home chat to search my mail, calendar, Teams and files and read a
 *             document or an Excel sheet, with MY sign-in — and, where an admin allowed it, to draft or
 *             send a plain-text mail as me after I confirmed the full message.
 * ARCHITECTURE:
 *   - Microsoft and Google run no remote MCP server a self-hosted OS can use tonight without extra
 *     tenant programmes (Work IQ needs admin-consented WorkIQ.* scopes and Copilot-credit billing;
 *     Google's Workspace MCP servers are a Developer Preview behind enrolment). So the OS exposes the
 *     vendor's documented REST APIs (Microsoft Graph v1.0, Google Drive v3) as MCP-shaped tools behind
 *     the same `ExternalMcpSource` port Notion's remote server uses. Swapping in a vendor MCP server
 *     later changes this file only.
 *   - Reads: every read tool is a GET (plus Graph's POST /search/query, a read) and carries `readOnly: true`.
 *   - Mail writes (`mail_draft`, `mail_send`) exist only when the connection's admin switch is on
 *     (`accountToolDefs(p, { mailSend: true })`). They carry `readOnly: false`, so OPA parks them for the
 *     confirm card and they run only after the same user confirmed. Input is validated locally first
 *     (`validateMailInput`: plain text, at most 10 recipients, valid addresses, size caps); a refusal makes
 *     no network call. A write is never retried: a 429 is reported, not repeated.
 *   - The access token comes in per call and is used only as the bearer to the vendor, through the
 *     adapter door `core/adapters/saas-http` (GLUE-1); `fetch` is injectable for tests. Results are compact JSON, long bodies cut at `TEXT_MAX` (said so).
 *   - Office files are read with `office-extract.ts`; PDFs are not converted here (the answer says so).
 */
import { config } from '@core/kernel/config';
import { ExternalMcpError, type ExternalCallResult, type ExternalToolDef } from '@core/runtime/external-mcp';
import type { ConnectionTemplateKey } from '@tabs/connections/lib/schema';
import { saasRequest, failureStatus, failureRetryAfter, failureErrorCode, failureMentionsPermission, type SaasResponse } from '@core/adapters/saas-http/client';
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
  /** Seconds the service asked to wait (a 429's Retry-After), when it said. */
  readonly retryAfter: number | null;
  /** The vendor's error code of a 403 (`ErrorAccessDenied`, `Authorization_RequestDenied`, …), when it said. */
  readonly code: string | null;
  /** The vendor's 403 message spoke of a missing permission, scope or consent (the text itself is not kept). */
  readonly permission: boolean;
  constructor(status: number, message: string, retryAfter: number | null = null, extra: { code?: string | null; permission?: boolean } = {}) {
    super(message);
    this.name = 'AccountApiError';
    this.remoteStatus = status;
    this.retryAfter = retryAfter;
    this.code = extra.code ?? null;
    this.permission = extra.permission === true;
  }
}

/** Arguments of a mail write that are refused locally, before any network call. */
export class MailInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailInputError';
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

// ------------------------------------------------------------------ mail draft / send ---

/** The mail write tools (Microsoft 365, only when the connection allows drafting and sending mail). */
export const MAIL_WRITE_TOOLS: readonly string[] = ['mail_draft', 'mail_send'];
/** Recipients (To + Cc) one mail may have. */
export const MAIL_MAX_RECIPIENTS = 10;
/** Characters of plain-text body one mail may carry. */
export const MAIL_BODY_MAX = 20_000;
/** Characters of subject. */
export const MAIL_SUBJECT_MAX = 255;

const mailSchema = (): ExternalToolDef['inputSchema'] => obj({
  to: { type: 'array', items: { type: 'string' }, description: 'Recipient e-mail addresses. For a reply: the people the reply goes to (normally the original sender).' },
  cc: { type: 'array', items: { type: 'string' }, description: 'Optional Cc addresses.' },
  subject: { type: 'string', description: `Subject of a new mail, at most ${MAIL_SUBJECT_MAX} characters. Leave it out for a reply: a reply keeps the thread's subject.` },
  body: { type: 'string', description: `Plain-text body, at most ${MAIL_BODY_MAX} characters. No HTML, no attachments.` },
  replyToMessageId: { type: 'string', description: 'Optional: the id of the message to reply to (from mail_search / mail_get).' },
}, ['to', 'body']);

const MAIL_TOOLS: ExternalToolDef[] = [
  { name: 'mail_draft', readOnly: false, inputSchema: mailSchema(), description: `Create a plain-text draft in the user's own Outlook Drafts (a new mail, or a reply draft when replyToMessageId is given). Nothing is sent. At most ${MAIL_MAX_RECIPIENTS} recipients, no attachments. Returns the draft id and its Outlook link.` },
  { name: 'mail_send', readOnly: false, inputSchema: mailSchema(), description: `Send a plain-text mail as the user from their own mailbox (a new mail, or a reply in the thread when replyToMessageId is given). At most ${MAIL_MAX_RECIPIENTS} recipients, no attachments. The user sees the full message on the confirm card first.` },
];

export function accountToolDefs(p: AccountProvider, opts: { mailSend?: boolean } = {}): ExternalToolDef[] {
  const src = p === 'm365' ? (opts.mailSend === true ? [...M365_TOOLS, ...MAIL_TOOLS] : M365_TOOLS) : p === 'onedrive' ? FILE_TOOLS_MS : GDRIVE_TOOLS;
  return src.map((t) => ({ ...t }));
}

export type MailInput = { to: string[]; cc: string[]; subject: string; body: string; replyToMessageId?: string };

// Deliberately conservative: a dot-atom local part and a dotted DNS host name (RFC 5321 sizes).
const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** Is `a` a plain e-mail address (no display name, comment or quoted local part)? */
export function isEmailAddress(a: string): boolean {
  if (a.length > 254) return false;
  const at = a.indexOf('@');
  if (at <= 0 || at !== a.lastIndexOf('@')) return false;
  const local = a.slice(0, at);
  const labels = a.slice(at + 1).split('.');
  return local.length <= 64 && LOCAL_PART.test(local) && labels.length >= 2 && labels.every((l) => DOMAIN_LABEL.test(l)) && /[A-Za-z]/.test(labels[labels.length - 1]);
}

/** Control characters other than tab, newline and carriage return. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function addressList(v: unknown, field: string): string[] {
  if (v === undefined || v === null) return [];
  const list = typeof v === 'string' ? [v] : v;
  if (!Array.isArray(list)) throw new MailInputError(`"${field}" must be a list of e-mail addresses.`);
  return list.map((x) => {
    if (typeof x !== 'string') throw new MailInputError(`"${field}" must be a list of e-mail addresses.`);
    const a = x.trim();
    if (!isEmailAddress(a)) throw new MailInputError(`"${a.slice(0, 80)}" in ${field} is not a valid e-mail address.`);
    return a;
  });
}

/**
 * Validate a mail_draft / mail_send call locally; returns the clean input or throws `MailInputError` with
 * a plain reason. Rules: at least one To; at most 10 distinct recipients in To + Cc; valid addresses; a
 * plain-text body of at most 20 000 characters; a one-line subject of at most 255 characters, required
 * for a new mail and refused on a reply (a reply keeps the thread's subject, so the card never shows a
 * subject that would not be used); no Bcc, HTML or attachment fields.
 */
export function validateMailInput(args: Record<string, unknown>): MailInput {
  for (const k of ['attachments', 'attachment', 'html', 'bodyHtml', 'contentType', 'bcc']) {
    if (args[k] !== undefined) throw new MailInputError(`"${k}" is not supported: mail from the chat is plain text to To and Cc, without attachments.`);
  }
  // Deduplicated case-insensitively across To + Cc (first spelling kept; an address in To is dropped from Cc),
  // so what is counted is exactly what is shown on the card and sent.
  const seen = new Set<string>();
  const once = (list: string[]) => list.filter((a) => { const k = a.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  const to = once(addressList(args.to, 'to'));
  const cc = once(addressList(args.cc, 'cc'));
  if (to.length === 0) throw new MailInputError('A mail needs at least one recipient in "to".');
  const distinct = to.length + cc.length;
  if (distinct > MAIL_MAX_RECIPIENTS) throw new MailInputError(`A mail from the chat may have at most ${MAIL_MAX_RECIPIENTS} recipients (To + Cc); this one has ${distinct}.`);
  if (typeof args.body !== 'string' || !args.body.trim()) throw new MailInputError('A mail needs a plain-text "body".');
  const body = args.body;
  if (body.length > MAIL_BODY_MAX) throw new MailInputError(`The body is ${body.length} characters; a mail from the chat may have at most ${MAIL_BODY_MAX}.`);
  if (CONTROL.test(body)) throw new MailInputError('The body contains control characters; send plain text only.');
  if (args.subject !== undefined && args.subject !== null && typeof args.subject !== 'string') throw new MailInputError('"subject" must be text.');
  const subject = typeof args.subject === 'string' ? args.subject.trim() : '';
  const rawReply = args.replyToMessageId;
  if (rawReply !== undefined && rawReply !== null && typeof rawReply !== 'string') throw new MailInputError('"replyToMessageId" must be a message id.');
  const replyToMessageId = typeof rawReply === 'string' && rawReply.trim() ? rawReply.trim() : undefined;
  if (replyToMessageId) {
    if (replyToMessageId.length > 512 || CONTROL.test(replyToMessageId) || /\s/.test(replyToMessageId)) throw new MailInputError('"replyToMessageId" is not a message id.');
    if (subject) throw new MailInputError('A reply keeps the thread\'s subject: leave "subject" out when replyToMessageId is given.');
  } else {
    if (!subject) throw new MailInputError('A new mail needs a "subject".');
    if (subject.length > MAIL_SUBJECT_MAX) throw new MailInputError(`The subject is ${subject.length} characters; at most ${MAIL_SUBJECT_MAX}.`);
    if (/[\r\n]/.test(subject) || CONTROL.test(subject)) throw new MailInputError('The subject must be one line of plain text.');
  }
  return { to, cc, subject, body, ...(replyToMessageId ? { replyToMessageId } : {}) };
}

const recipients = (list: string[]) => list.map((address) => ({ emailAddress: { address } }));

const MAIL_LABEL = 'Microsoft 365';
const did = (tool: string) => (tool === 'mail_send' ? 'sent' : 'drafted');

/** Plain text as HTML that renders exactly as typed: the five HTML specials escaped, line breaks as `<br>`. */
export function textToHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    .replace(/\r\n|\r|\n/g, '<br>');
}

/**
 * Is a 403 on a mail write a missing permission (reconnecting can help) rather than a mailbox or
 * organisation policy (it cannot)? Only Graph's consent/authorization codes, or `ErrorAccessDenied` whose
 * message speaks of a permission or scope.
 */
export function isPermissionRefusal(e: Pick<AccountApiError, 'code' | 'permission'>): boolean {
  if (e.code === 'Authorization_RequestDenied') return true;
  return (e.code === 'ErrorAccessDenied' || e.code === 'AccessDenied') && e.permission;
}

/** The answer when the caller's sign-in does not (yet) grant drafting and sending mail. */
export function mailReconnectError(note = ''): ExternalMcpError {
  return new ExternalMcpError(
    'needs_connect',
    `Your ${MAIL_LABEL} sign-in does not allow drafting and sending mail yet. Nothing was drafted or sent.${note ? ` ${note}` : ''}`,
    'Click "Reconnect to allow sending" under the answer, sign in again and accept the two mail permissions, then ask again.',
  );
}

/** Where in a mail write a failure happened: it decides what is KNOWN about the outcome. */
type MailStage = 'single' | 'createReply' | 'patch' | 'send';

/**
 * A failed mail write in the chat's typed words. A timeout, a lost connection or a 5xx does NOT say "try
 * again" where the mail may have gone out: it says the outcome is unknown and to look in Sent Items / Drafts
 * first, so nothing is sent twice. `note` is appended (e.g. what happened to a reply draft).
 */
export function mailFailure(e: unknown, tool: string, stage: MailStage = 'single', note = ''): ExternalMcpError {
  if (e instanceof ExternalMcpError) return e;
  if (e instanceof MailInputError) return new ExternalMcpError('invalid_request', `${e.message} Nothing was drafted or sent.`, 'Fix the message and try again.');
  const err = e as Partial<AccountApiError> & Error;
  const st = typeof err.remoteStatus === 'number' ? err.remoteStatus : 0;
  const n = note ? ` ${note}` : '';
  const unclear = st === 0 || st >= 500 || err instanceof SyntaxError;
  const what = unclear ? (st >= 500 ? `HTTP ${st}` : err instanceof SyntaxError ? 'an unreadable answer' : 'no answer in time') : `HTTP ${st}`;
  if (unclear) {
    if (stage === 'patch') {
      // The reply was being prepared; send was never called, so nothing went out.
      return new ExternalMcpError('tool_error', `${MAIL_LABEL} did not confirm the reply (${what}). Nothing was sent.${n}`, 'Try again in a moment.');
    }
    if (stage === 'createReply') {
      return new ExternalMcpError('outcome_unknown', `${MAIL_LABEL} gave no clear answer (${what}), so it is not known whether it created a reply draft. Nothing was sent.${n}`, 'Check your Drafts in Outlook before you try again.');
    }
    if (stage === 'send') {
      return new ExternalMcpError('outcome_unknown', `${MAIL_LABEL} gave no clear answer (${what}), so it is not known whether the reply was sent. If it was not, it is in your Drafts.${n}`, 'Check Sent Items and Drafts in Outlook before you try again, so it does not go out twice.');
    }
    return new ExternalMcpError('outcome_unknown', `${MAIL_LABEL} gave no clear answer (${what}), so it is not known whether the mail was ${did(tool)}.${n}`, 'Check Sent Items and Drafts in Outlook before you try again, so it does not go out twice.');
  }
  const nothing = stage === 'send' ? 'It was not sent.' : `Nothing was ${did(tool)}.`;
  if (st === 429) {
    const wait = typeof err.retryAfter === 'number' ? `in about ${err.retryAfter} s` : 'in a minute';
    return new ExternalMcpError('rate_limited', `${MAIL_LABEL} is limiting requests right now. ${nothing}${n}`, `Try again ${wait}.`);
  }
  if (st === 403) {
    if (isPermissionRefusal({ code: err.code ?? null, permission: err.permission === true })) return mailReconnectError(n.trim());
    return new ExternalMcpError(
      'no_access',
      `Microsoft refused to ${tool === 'mail_send' ? 'send' : 'draft'} this mail: ${err.code ?? 'HTTP 403'}. ${nothing}${n}`,
      'This is a mailbox or organisation rule in Microsoft 365, not your sign-in in the OS; reconnecting will not change it. Ask your Microsoft 365 administrator.',
    );
  }
  if (st === 401) return new ExternalMcpError('needs_connect', `${MAIL_LABEL} refused your sign-in. ${nothing}${n}`, `Click "Connect your ${MAIL_LABEL} account" to sign in again.`);
  if (st === 404) return new ExternalMcpError('no_access', `The message to reply to was not found, or your account cannot see it. ${nothing}${n}`, 'Find the message again with mail_search.');
  return new ExternalMcpError('tool_error', `${MAIL_LABEL} refused the mail (${what}). ${nothing}${n}`, 'Adjust the message and try again.');
}

/**
 * The reply's HTML body: our text (escaped, `white-space: pre-wrap` so spaces and tabs keep the layout the
 * card's <pre> showed) placed INSIDE the draft's `<body …>` right after its opening tag when the draft is a
 * full document, otherwise in front of the fragment; then the quoted original.
 */
export function replyHtml(text: string, quotedHtml: string): string {
  const ours = `<div style="white-space:pre-wrap">${textToHtml(text)}</div><br>`;
  const open = /<body\b[^>]*>/i.exec(quotedHtml);
  if (!open) return `${ours}${quotedHtml}`;
  const at = open.index + open[0].length;
  return `${quotedHtml.slice(0, at)}${ours}${quotedHtml.slice(at)}`;
}

/**
 * How the card names a sender. The ADDRESS is the authoritative part: `Name <address>`, but only the address
 * when the display name could pass for one (it contains `@`, `<` or `>`), since anyone can set a display name.
 */
export function senderLabel(name: string, address: string): string {
  const n = name.trim();
  const a = address.trim();
  if (!a) return n ? `${n} (no address given)` : '';
  if (!n || /[@<>]/.test(n)) return a;
  return `${n} <${a}>`;
}

/** Subject and sender of the message a reply goes to — what the confirm card names. A read. */
export async function mailThread(token: string, messageId: string, opts: { fetchImpl?: FetchFn } = {}): Promise<{ subject: string; from: string }> {
  const r = await getJson({ token, fetchImpl: opts.fetchImpl }, graph(`/me/messages/${enc(messageId)}?$select=subject,from`));
  const from = ((r.from as J | undefined)?.emailAddress ?? {}) as J;
  return { subject: s(r.subject), from: senderLabel(s(from.name), s(from.address)) };
}

/**
 * One mail write over Graph v1.0.
 *  - New mail, mail_send:  POST /me/sendMail { message (body contentType Text), saveToSentItems: true }   → 202
 *  - New mail, mail_draft: POST /me/messages { subject, body (Text), toRecipients, ccRecipients }       → 201
 *  - Reply (both): POST /me/messages/{id}/createReply with NO body (Exchange fills the thread, the original
 *    recipients and the quoted original) → PATCH /me/messages/{draftId} setting toRecipients / ccRecipients
 *    to EXACTLY the confirmed lists and the body to our text, HTML-escaped with <br> line breaks, above the
 *    draft's own HTML (the quoted original) → mail_send only: POST /me/messages/{draftId}/send. If the PATCH
 *    fails the orphan draft is deleted (best effort) and the answer says whether that worked.
 */
async function mailWrite(ctx: Ctx, tool: string, m: MailInput): Promise<ExternalCallResult> {
  const json = { 'content-type': 'application/json' };
  const reply = m.replyToMessageId;
  const mode = reply ? 'reply' : 'new';
  const summary = { mode, to: m.to, cc: m.cc, ...(reply ? { replyToMessageId: reply } : { subject: m.subject }) };
  const audit = { action: tool, mode, recipients: m.to.length + m.cc.length };

  if (!reply) {
    const message = { subject: m.subject, body: { contentType: 'Text', content: m.body }, toRecipients: recipients(m.to), ...(m.cc.length ? { ccRecipients: recipients(m.cc) } : {}) };
    try {
      if (tool === 'mail_send') {
        await http(ctx, graph('/me/sendMail'), { method: 'POST', headers: json, body: JSON.stringify({ message, saveToSentItems: true }) });
        return { ...ok({ sent: true, ...summary }), audit };
      }
      const r = parseJsonBody(await http(ctx, graph('/me/messages'), { method: 'POST', headers: json, body: JSON.stringify(message) }));
      return { ...ok({ drafted: true, draftId: s(r.id), webLink: s(r.webLink), ...summary }), audit };
    } catch (e) {
      throw mailFailure(e, tool, 'single');
    }
  }

  // 1. createReply, no body: Exchange builds the reply in the user's Drafts.
  let draft: J;
  try {
    draft = parseJsonBody(await http(ctx, graph(`/me/messages/${enc(reply)}/createReply`), { method: 'POST' }));
  } catch (e) {
    throw mailFailure(e, tool, 'createReply');
  }
  const draftId = s(draft.id);
  if (!draftId) throw new ExternalMcpError('outcome_unknown', `${MAIL_LABEL} created no reply draft it could name. Nothing was sent.`, 'Check your Drafts in Outlook before you try again.');
  const draftPath = `/me/messages/${enc(draftId)}`;
  const removeDraft = async (): Promise<string> => {
    try {
      await http(ctx, graph(draftPath), { method: 'DELETE' });
      return 'The unfinished reply draft was removed.';
    } catch {
      return 'The unfinished reply draft could not be removed: delete it from your Drafts.';
    }
  };

  // 2. PATCH: exactly the confirmed recipients, our text (escaped) above the quoted original.
  let patched: J;
  try {
    let original = (draft.body ?? null) as J | null;
    if (!original || typeof original.content !== 'string') original = ((await getJson(ctx, graph(`${draftPath}?$select=body`))).body ?? {}) as J;
    const quoted = s(original.contentType).toLowerCase() === 'html' ? s(original.content) : textToHtml(s(original.content));
    const body = { contentType: 'HTML', content: replyHtml(m.body, quoted) };
    patched = parseJsonBody(await http(ctx, graph(draftPath), {
      method: 'PATCH', headers: json, body: JSON.stringify({ toRecipients: recipients(m.to), ccRecipients: recipients(m.cc), body }),
    }));
  } catch (e) {
    throw mailFailure(e, tool, 'patch', await removeDraft());
  }
  const webLink = s(patched.webLink) || s(draft.webLink);
  if (tool === 'mail_draft') return { ...ok({ drafted: true, draftId, webLink, ...summary }), audit };

  // 3. send the prepared reply.
  try {
    await http(ctx, graph(`${draftPath}/send`), { method: 'POST' });
  } catch (e) {
    throw mailFailure(e, tool, 'send', 'The prepared reply stays in your Drafts.');
  }
  return { ...ok({ sent: true, ...summary }), audit };
}

// ------------------------------------------------------------------ http ---

type Ctx = { token: string; fetchImpl?: FetchFn };

/** One vendor call through the adapter door; a failure becomes an `AccountApiError` with its HTTP status. */
async function http(ctx: Ctx, url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}, opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<SaasResponse> {
  const r = await saasRequest(url, { ...init, bearer: ctx.token, ...opts }, ctx.fetchImpl);
  if (r.ok) return r.value;
  const status = failureStatus(r);
  if (status === 413) throw new AccountApiError(413, `The file is larger than ${Math.round((opts.maxBytes ?? FILE_MAX_BYTES) / 1048576)} MB, the most the chat reads.`);
  const e = new AccountApiError(status, `The service answered ${status || r.reason}.`, status === 429 ? failureRetryAfter(r) : null, { code: failureErrorCode(r), permission: failureMentionsPermission(r) }); // never echo the body
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

/**
 * The cheapest AUTHENTICATED read of an account, for the Connections "Test": Graph `/me` (Microsoft
 * 365), Graph `/me/drive` (OneDrive), Drive `about.get` (Google). Returns the account it belongs to
 * when the vendor says. Throws `AccountApiError` (401 = sign-in refused) on a vendor failure.
 */
export async function verifyAccount(p: AccountProvider, token: string, opts: { fetchImpl?: FetchFn } = {}): Promise<{ subject: string | null }> {
  const ctx = { token, fetchImpl: opts.fetchImpl };
  if (p === 'gdrive') {
    const r = await getJson(ctx, gapi('/about?fields=user(emailAddress)'));
    return { subject: s((r.user as J | undefined)?.emailAddress) || null };
  }
  if (p === 'onedrive') {
    const r = await getJson(ctx, graph('/me/drive?$select=id,owner'));
    return { subject: s((((r.owner as J | undefined)?.user) as J | undefined)?.email) || null };
  }
  const r = await getJson(ctx, graph('/me?$select=userPrincipalName,mail'));
  return { subject: s(r.mail) || s(r.userPrincipalName) || null };
}

/**
 * Run one account tool with the user's access token. Throws `AccountApiError` on a vendor failure and
 * `MailInputError` (before any request) on a mail write with invalid input. The mail writes exist only
 * with `mailSend: true` (the connection's switch); the caller has already checked the user's grant.
 */
export async function callAccountTool(p: AccountProvider, token: string, tool: string, args: Record<string, unknown>, opts: { fetchImpl?: FetchFn; mailSend?: boolean } = {}): Promise<ExternalCallResult> {
  if (!accountToolDefs(p, { mailSend: opts.mailSend }).some((t) => t.name === tool)) throw new AccountApiError(400, `Unknown tool ${tool}.`);
  const ctx = { token, fetchImpl: opts.fetchImpl };
  if (MAIL_WRITE_TOOLS.includes(tool)) return mailWrite(ctx, tool, validateMailInput(args));
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
