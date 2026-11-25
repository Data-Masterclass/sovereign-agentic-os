/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Drop, paste or attach files in a chat composer
 * USER STORY: As a user I want to drag files onto the chat, paste them, or pick them with an Attach
 *             button (keyboard included), see each as a chip that says where it will land, change
 *             that before sending, and have the assistant told what was created in the same turn.
 * ARCHITECTURE:
 *   - One hook (`useChatAttachments`) and two pieces of UI (`AttachButton`, `AttachmentTray`) used
 *     by BOTH composers: Home (`tabs/home/ui/HomeChat.tsx`) and the drawer (`core/ui/OsAssistant.tsx`).
 *   - State transitions are pure and tested in `chat-attachments-view.ts`; the type sniff is the
 *     shared `core/runtime/chat-attachments.ts`, run here on the first and last 64 KB of the File.
 *   - `upload()` posts the ready files (multipart) to `POST /api/assistant/attachments`, which
 *     re-sniffs, policy-checks, writes to My scope and audits; the composer then sends the turn with
 *     `composeWithAttachments(text, results)` in front, so the assistant knows the new ids.
 *   - File content is never rendered or executed here; names are sanitised before display.
 */
'use client';

import { useCallback, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import {
  ATTACH_ACCEPT,
  DESTINATION_LABEL,
  SNIFF_WINDOW,
  sniffAttachment,
  type AttachmentResult,
  type Sniff,
} from '@core/runtime/chat-attachments';
import {
  admit, applyResults, checking, chipLabel, chooseDestination, formatSize, removeChip, sendable, sniffed, type Chip,
} from '@core/ui/chat-attachments-view';

async function sniffFile(f: File): Promise<Sniff> {
  const head = new Uint8Array(await f.slice(0, SNIFF_WINDOW).arrayBuffer());
  const tail = f.size > SNIFF_WINDOW ? new Uint8Array(await f.slice(Math.max(SNIFF_WINDOW, f.size - SNIFF_WINDOW)).arrayBuffer()) : undefined;
  return sniffAttachment(f.name, head, { tail, size: f.size });
}

let seq = 0;
const nextKey = () => `att-${Date.now().toString(36)}-${(seq += 1)}`;

export type ChatAttachments = ReturnType<typeof useChatAttachments>;

export function useChatAttachments() {
  const [chips, setChips] = useState<Chip[]>([]);
  const [notice, setNotice] = useState('');
  const [dragging, setDragging] = useState(false);
  const files = useRef(new Map<string, File>());
  const depth = useRef(0);
  const chipsRef = useRef<Chip[]>([]);
  chipsRef.current = chips;

  const add = useCallback((list: FileList | File[] | null | undefined) => {
    const incoming = Array.from(list ?? []);
    if (incoming.length === 0) return;
    const { chips: next, admitted, notice: n } = admit(chipsRef.current, incoming, nextKey);
    chipsRef.current = next;
    setChips(next);
    setNotice(n);
    for (const { key, file } of admitted) {
      files.current.set(key, file);
      void sniffFile(file)
        .then((s) => setChips((c) => sniffed(c, key, s)))
        .catch(() => setChips((c) => sniffed(c, key, { ok: false, reason: 'The file could not be read.' })));
    }
  }, []);

  const remove = useCallback((key: string) => {
    files.current.delete(key);
    setChips((c) => removeChip(c, key));
    setNotice('');
  }, []);
  const setDestination = useCallback((key: string, dest: string) => setChips((c) => chooseDestination(c, key, dest)), []);
  const clear = useCallback(() => { files.current.clear(); setChips([]); setNotice(''); }, []);

  /** Upload the ready chips. Returns the per-file results (empty when nothing was attached). Throws on a refused request. */
  const upload = useCallback(async (signal?: AbortSignal): Promise<AttachmentResult[]> => {
    const ready = sendable(chipsRef.current);
    if (ready.length === 0) return [];
    const form = new FormData();
    for (const c of ready) {
      const f = files.current.get(c.key);
      if (f) form.append('file', f, f.name);
    }
    form.append('destinations', JSON.stringify(ready.map((c) => c.destination ?? null)));
    const keys = ready.map((c) => c.key);
    setChips((all) => all.map((c) => (keys.includes(c.key) ? { ...c, state: 'uploading' } : c)));
    let res: Response;
    try {
      res = await fetch('/api/assistant/attachments', { method: 'POST', body: form, signal });
    } catch (e) {
      setChips((all) => all.map((c) => (keys.includes(c.key) ? { ...c, state: 'ready' } : c)));
      throw e;
    }
    const j = (await res.json().catch(() => ({}))) as { results?: AttachmentResult[]; error?: string };
    if (!Array.isArray(j.results)) {
      setChips((all) => all.map((c) => (keys.includes(c.key) ? { ...c, state: 'ready' } : c)));
      throw new Error(j.error ?? `The attachments could not be uploaded (${res.status}).`);
    }
    setChips((all) => applyResults(all, keys, j.results!));
    return j.results;
  }, []);

  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  const dropZoneProps = {
    onDragEnter: (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); depth.current += 1; setDragging(true); },
    onDragOver: (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; },
    onDragLeave: (e: DragEvent) => { if (!hasFiles(e)) return; depth.current = Math.max(0, depth.current - 1); if (depth.current === 0) setDragging(false); },
    onDrop: (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); depth.current = 0; setDragging(false); add(e.dataTransfer.files); },
  };
  /** Paste: files on the clipboard are attached; plain text pastes as usual. */
  const onPaste = (e: ClipboardEvent) => {
    const list = e.clipboardData?.files;
    if (list && list.length > 0) { e.preventDefault(); add(list); }
  };

  return {
    chips, notice, dragging, add, remove, setDestination, clear, upload, dropZoneProps, onPaste,
    /** Send waits while a file is still being checked. */
    busy: checking(chips) || chips.some((c) => c.state === 'uploading'),
    /** Something will be uploaded on send. */
    ready: sendable(chips).length > 0,
  };
}

/** The keyboard-accessible Attach button: a real button that opens the system file picker. */
export function AttachButton({ att, disabled, className }: { att: ChatAttachments; disabled?: boolean; className?: string }) {
  const input = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <button
        type="button"
        className={className ?? 'att-btn'}
        onClick={() => input.current?.click()}
        disabled={disabled}
        aria-label="Attach files (CSV, Excel, Parquet, JSON, PDF, Word, PowerPoint, markdown)"
        title="Attach files — or drop or paste them here"
      >
        <span aria-hidden>📎</span> Attach
      </button>
      <input
        ref={input}
        type="file"
        multiple
        accept={ATTACH_ACCEPT}
        hidden
        tabIndex={-1}
        onChange={(e) => { att.add(e.target.files); e.target.value = ''; }}
      />
    </>
  );
}

/** The chips, the drop hint and the over-the-limit notice. */
export function AttachmentTray({ att, disabled }: { att: ChatAttachments; disabled?: boolean }) {
  return (
    <>
      {att.dragging ? (
        <div className="att-drop" aria-hidden>
          <span>Drop files to attach — data goes to Data, documents to Files, markdown to Knowledge</span>
        </div>
      ) : null}
      {att.chips.length > 0 || att.notice ? (
        <div className="att-tray">
          {att.chips.length > 0 ? (
            <ul className="att-chips" aria-label="Attached files">
              {att.chips.map((c) => (
                <li key={c.key} className={`att-chip is-${c.state}`} title={chipLabel(c)}>
                  <span className="att-name">{c.name}</span>
                  <span className="att-size">{formatSize(c.size)}</span>
                  {c.state === 'ready' && c.destinations.length > 1 ? (
                    <select
                      className="att-dest"
                      value={c.destination}
                      disabled={disabled}
                      aria-label={`Destination for ${c.name}`}
                      onChange={(e) => att.setDestination(c.key, e.target.value)}
                    >
                      {c.destinations.map((d) => <option key={d} value={d}>{DESTINATION_LABEL[d]}</option>)}
                    </select>
                  ) : c.destination ? (
                    <span className="att-dest-fixed">{DESTINATION_LABEL[c.destination]}</span>
                  ) : null}
                  {c.state === 'checking' || c.state === 'uploading' ? <span className="spin" aria-hidden /> : null}
                  {c.state === 'done' && c.href ? <a className="att-open" href={c.href}>Open</a> : null}
                  {c.message && (c.state === 'refused' || c.state === 'failed') ? <span className="att-msg" role="note">{c.message}</span> : null}
                  {c.state !== 'uploading' ? (
                    <button type="button" className="att-x" aria-label={`Remove ${c.name}`} onClick={() => att.remove(c.key)} disabled={disabled}>×</button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {att.notice ? <p className="att-notice" role="alert">{att.notice}</p> : null}
          <p className="att-live" aria-live="polite">
            {att.chips.map(chipLabel).join('. ')}
          </p>
        </div>
      ) : null}
    </>
  );
}
