/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The composer's attachment chips — what the user dropped, where each one will go
 * USER STORY: As a user I want each file I drop, paste or attach to show as a chip that says where
 *             it will land (Data, Files or Knowledge), let me change that before I send, refuse a
 *             file it cannot take with a reason, and stop me at five files per message.
 * ARCHITECTURE:
 *   - Pure state transitions for `ChatAttachments.tsx` (a test cannot import a .tsx), shared by both
 *     chat composers (Home and the global drawer).
 *   - The chip's destination is a PRE-selection from the client-side sniff; the server sniffs the
 *     bytes again and checks the choice against the same routing table (`chat-attachments.ts`).
 */
import {
  ATTACHMENT_MAX_FILES,
  DESTINATION_LABEL,
  destinationAllowed,
  sanitizeFilename,
  type AttachmentKind,
  type AttachmentResult,
  type Destination,
  type Sniff,
} from '@core/runtime/chat-attachments';

export type ChipState = 'checking' | 'ready' | 'refused' | 'uploading' | 'done' | 'failed';
export type Chip = {
  key: string;
  name: string;
  size: number;
  kind?: AttachmentKind;
  destinations: readonly Destination[];
  destination?: Destination;
  state: ChipState;
  message?: string;
  href?: string;
};

/** Admit new files up to the per-message cap; the rest are named in a notice, never silently dropped. */
export function admit<T extends { name: string; size: number }>(
  current: readonly Chip[],
  incoming: readonly T[],
  nextKey: () => string,
): { chips: Chip[]; admitted: { key: string; file: T }[]; notice: string } {
  const room = Math.max(0, ATTACHMENT_MAX_FILES - current.length);
  const take = incoming.slice(0, room);
  const left = incoming.slice(room);
  const admitted = take.map((file) => ({ key: nextKey(), file }));
  const chips = [
    ...current,
    ...admitted.map(({ key, file }) => ({ key, name: sanitizeFilename(file.name), size: file.size, destinations: [], state: 'checking' as const })),
  ];
  const notice = left.length
    ? `A message can carry at most ${ATTACHMENT_MAX_FILES} files — not attached: ${left.map((f) => sanitizeFilename(f.name)).join(', ')}.`
    : '';
  return { chips, admitted, notice };
}

/** Apply the client-side sniff to a chip: pre-select the default destination, or refuse with the reason. */
export function sniffed(chips: readonly Chip[], key: string, s: Sniff): Chip[] {
  return chips.map((c) => {
    if (c.key !== key) return c;
    return s.ok
      ? { ...c, kind: s.kind, destinations: s.destinations, destination: s.defaultDestination, state: 'ready', message: undefined }
      : { ...c, destinations: [], destination: undefined, state: 'refused', message: s.reason };
  });
}

/** The user picked a destination; only one the routing table allows for that kind is taken. */
export function chooseDestination(chips: readonly Chip[], key: string, dest: string): Chip[] {
  return chips.map((c) => (c.key === key && c.kind && destinationAllowed(c.kind, dest) ? { ...c, destination: dest } : c));
}

export const removeChip = (chips: readonly Chip[], key: string): Chip[] => chips.filter((c) => c.key !== key);

/** The chips that will be sent (ready ones); a refused chip is never uploaded. */
export const sendable = (chips: readonly Chip[]): Chip[] => chips.filter((c) => c.state === 'ready');
/** Still sniffing: the Send button waits. */
export const checking = (chips: readonly Chip[]): boolean => chips.some((c) => c.state === 'checking');

/** Only an in-OS path is ever linked from a chip (never another origin, never `javascript:`). */
export const sameOriginPath = (href: string | undefined): string | undefined =>
  href && /^\/(?![/\\])/.test(href) ? href : undefined;

/** Fold the server's per-file results back onto the chips that were sent (in order). */
export function applyResults(chips: readonly Chip[], sentKeys: readonly string[], results: readonly AttachmentResult[]): Chip[] {
  const byKey = new Map(sentKeys.map((k, i) => [k, results[i]]));
  return chips.map((c) => {
    const r = byKey.get(c.key);
    if (!r) return c;
    return r.outcome === 'created'
      ? { ...c, state: 'done', destination: r.destination ?? c.destination, message: r.item?.detail, href: sameOriginPath(r.item?.href) }
      : { ...c, state: 'failed', message: r.message };
  });
}

/** A chip's one-line label for screen readers and the title tooltip. */
export function chipLabel(c: Chip): string {
  if (c.state === 'refused' || c.state === 'failed') return `${c.name}: ${c.message ?? 'not uploaded'}`;
  if (c.state === 'checking') return `${c.name}: checking the file type`;
  const where = c.destination ? DESTINATION_LABEL[c.destination] : '';
  if (c.state === 'done') return `${c.name}: uploaded to ${where}`;
  if (c.state === 'uploading') return `${c.name}: uploading to ${where}`;
  return `${c.name}: will go to ${where}`;
}

export function formatSize(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
