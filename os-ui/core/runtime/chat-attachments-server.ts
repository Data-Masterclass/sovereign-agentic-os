/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The chat attachment door — route each attached file to Data, Files or Knowledge
 * USER STORY: As a user I want the files I attach to a chat message to land in my own My scope
 *             through the same services the Data, Files and Knowledge tabs use — each one checked
 *             by policy before anything is written and recorded in the audit trail either way.
 * ARCHITECTURE:
 *   - The kernel never imports a tab, so the three destinations are PORTS (`AttachmentSinks`),
 *     registered at boot by `os-ui/chat-attachment-sinks.ts` (the one file allowed to know the
 *     kernel and the tabs, like `domain-delete-sources.ts`). Each sink calls that tab's EXISTING
 *     service — no ingest logic is duplicated here.
 *   - Per file, in order: sanitise the name → size cap → sniff the CONTENT
 *     (`chat-attachments.ts`) → check the requested destination against the closed routing table
 *     → OPA create decision (`authorize`, the `upload_create` rule) → the sink writes → one audit
 *     record (who, what, destination, outcome). A refused or denied file writes nothing.
 *   - More than ATTACHMENT_MAX_FILES files, or a request over the total cap, refuses EVERY file
 *     before anything is written (each still gets an audit record).
 *   - Testable without a route: the route only parses multipart and hands bytes here.
 */
import {
  ATTACHMENT_MAX_FILES,
  DESTINATION_LABEL,
  composeWithAttachments,
  destinationAllowed,
  isUtf8Text,
  sanitizeFilename,
  sniffBytes,
  storedName,
  titleOf,
  type AttachmentKind,
  type AttachmentResult,
  type CreatedItem,
  type Destination,
} from '@core/runtime/chat-attachments';
import type { Role } from '@core/kernel/session';

export type AttachmentUser = { id: string; name?: string; domains: string[]; role: Role };

/** One destination's writer: the tab's existing service, bound by the boot wiring. */
export type AttachmentSink = {
  /** The largest file this destination accepts, in bytes. */
  maxBytes: () => number;
  /** Create the item in the caller's My scope. Throws (with a plain message) when it could not. */
  create: (user: AttachmentUser, input: { name: string; title: string; kind: AttachmentKind; bytes: Buffer }) => Promise<CreatedItem>;
};
export type AttachmentSinks = Record<Destination, AttachmentSink>;

export type AttachmentAuditEntry = {
  actor: string;
  role: Role;
  action: 'assistant.attachment.create';
  target: string;
  detail: string;
  result: 'ok' | 'denied' | 'error';
  data: Record<string, unknown>;
  decisionId?: string;
  policyRev?: string;
};

export type AttachmentPorts = {
  sinks: AttachmentSinks;
  /** The OPA create decision for this caller and destination (never fails open). */
  authorizeCreate: (user: AttachmentUser, destination: Destination) => Promise<{ allowed: boolean; policy?: string; decisionId?: string; policyRev?: string }>;
  audit: (entry: AttachmentAuditEntry) => void;
};

export type IncomingAttachment = { name: string; bytes: Buffer; destination?: unknown };

/**
 * A sink failure that left something behind it could NOT take back (e.g. a landed table whose drop
 * failed): the item is kept and named, so the user can find it, instead of claiming nothing was kept.
 */
export class AttachmentKeptError extends Error {
  readonly item: CreatedItem;
  constructor(message: string, item: CreatedItem) {
    super(message);
    this.name = 'AttachmentKeptError';
    this.item = item;
  }
}

const NOUN: Record<Destination, string> = { data: 'a dataset', files: 'a file', knowledge: 'a knowledge note' };

/** Route every attached file. Returns one result per file, in order, and the reference block for the turn. */
export async function routeAttachments(
  user: AttachmentUser,
  files: readonly IncomingAttachment[],
  ports: AttachmentPorts,
  opts: { totalMaxBytes?: number } = {},
): Promise<{ results: AttachmentResult[]; reference: string; refusedAll: boolean }> {
  const record = (r: AttachmentResult, bytes: number, decision: { policy?: string; decisionId?: string; policyRev?: string } = {}) => {
    const { policy, ...meta } = decision;
    ports.audit({
      actor: user.id,
      role: user.role,
      action: 'assistant.attachment.create',
      target: r.item ? `${r.destination}:${r.item.id}` : `${r.destination ?? 'none'}:${r.name}`,
      detail: r.outcome === 'created'
        ? `Chat attachment "${r.name}" created as ${NOUN[r.destination!]} in My scope`
        : `Chat attachment "${r.name}" ${r.outcome}: ${r.message}`,
      result: r.outcome === 'created' ? 'ok' : r.outcome === 'failed' ? 'error' : 'denied',
      data: { name: r.name, kind: r.kind ?? null, destination: r.destination ?? null, outcome: r.outcome, bytes, itemId: r.item?.id ?? null, scope: 'my', ...(policy ? { policy } : {}) },
      ...meta,
    });
    return r;
  };

  // Whole-message limits: refuse every file before anything is written.
  const total = files.reduce((n, f) => n + f.bytes.length, 0);
  const tooMany = files.length > ATTACHMENT_MAX_FILES;
  const tooBig = opts.totalMaxBytes !== undefined && total > opts.totalMaxBytes;
  if (tooMany || tooBig) {
    const message = tooMany
      ? `A message can carry at most ${ATTACHMENT_MAX_FILES} files (this one had ${files.length}). Nothing was uploaded.`
      : `These files together exceed the ${Math.round(opts.totalMaxBytes! / 1048576)} MB a message can carry. Nothing was uploaded.`;
    const results = files.map((f) => record({ name: sanitizeFilename(f.name), outcome: 'rejected', message }, f.bytes.length));
    return { results, reference: '', refusedAll: true };
  }

  const results: AttachmentResult[] = [];
  for (const f of files) {
    const name = sanitizeFilename(f.name);
    const sniff = sniffBytes(name, f.bytes);
    if (!sniff.ok) {
      results.push(record({ name, outcome: 'rejected', message: sniff.reason }, f.bytes.length));
      continue;
    }
    const kind = sniff.kind;
    let destination: Destination = sniff.defaultDestination;
    if (f.destination !== undefined && f.destination !== null && f.destination !== '') {
      if (!destinationAllowed(kind, f.destination)) {
        const may = sniff.destinations.map((d) => DESTINATION_LABEL[d]).join(' or ');
        results.push(record({ name, kind, outcome: 'rejected', message: `A ${kind.toUpperCase()} file cannot go to ${typeof f.destination === 'string' ? f.destination : 'that destination'}; choose ${may}.` }, f.bytes.length));
        continue;
      }
      destination = f.destination;
    }
    const sink = ports.sinks[destination];
    const max = sink.maxBytes();
    if (f.bytes.length > max) {
      results.push(record({ name, kind, destination, outcome: 'rejected', message: `It is larger than the ${max >= 1048576 ? `${Math.round(max / 1048576)} MB` : `${Math.round(max / 1024)} KB`} ${DESTINATION_LABEL[destination]} accepts.` }, f.bytes.length));
      continue;
    }
    // A note is stored as text: the WHOLE file must be UTF-8 (the sniff only read its head).
    if (destination === 'knowledge' && !isUtf8Text(f.bytes)) {
      results.push(record({ name, kind, destination, outcome: 'rejected', message: 'It is not UTF-8 text throughout, so it cannot be saved as a knowledge note. Save it as UTF-8, or send it to Files.' }, f.bytes.length));
      continue;
    }
    const decision = await ports.authorizeCreate(user, destination);
    const meta = {
      ...(decision.policy ? { policy: decision.policy } : {}),
      ...(decision.decisionId ? { decisionId: decision.decisionId } : {}),
      ...(decision.policyRev ? { policyRev: decision.policyRev } : {}),
    };
    if (!decision.allowed) {
      const message = decision.policy === 'opa-unreachable'
        ? `The policy engine did not answer, so creating ${NOUN[destination]} was not allowed (it never fails open). Nothing was written; try again shortly.`
        : `Policy did not allow creating ${NOUN[destination]} in your My scope. Nothing was written.`;
      results.push(record({ name, kind, destination, outcome: 'denied', message }, f.bytes.length, meta));
      continue;
    }
    const stored = storedName(name, kind);
    try {
      const item = await sink.create(user, { name: stored, title: titleOf(stored), kind, bytes: f.bytes });
      results.push(record({ name, kind, destination, outcome: 'created', message: `Created ${NOUN[destination]} in My scope.`, item }, f.bytes.length, meta));
    } catch (e) {
      const kept = e instanceof AttachmentKeptError ? { item: e.item } : {};
      results.push(record({ name, kind, destination, outcome: 'failed', message: (e as Error).message || 'It could not be uploaded.', ...kept }, f.bytes.length, meta));
    }
  }
  return { results, reference: composeWithAttachments('', results), refusedAll: false };
}

// ---------------------------------------------------------------- wiring --

/** What the boot wiring registers: the sinks and the audit writer. The OPA port is supplied by the
 *  door itself (the route calls `authorize`), so the policy check is visible where the effect is. */
export type AttachmentWiring = Omit<AttachmentPorts, 'authorizeCreate'>;
const WIRING = Symbol.for('soa.chat-attachments.wiring');
export function registerAttachmentWiring(p: AttachmentWiring): void {
  (globalThis as unknown as Record<symbol, AttachmentWiring>)[WIRING] = p;
}
export function attachmentWiring(): AttachmentWiring {
  const p = (globalThis as unknown as Record<symbol, AttachmentWiring | undefined>)[WIRING];
  if (!p) throw Object.assign(new Error('Chat attachments are not wired in this process (instrumentation did not register them).'), { status: 503 });
  return p;
}
