/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       ui
 * FEATURE:    The Go live / Retire client calls and the ONE confirm dialog's copy
 * USER STORY: As a user I want one button, one dialog that tells me exactly what will start
 *             running, and — if something it depends on is still a draft — a refusal that names
 *             what to fix rather than a greyed-out button with no explanation.
 * ARCHITECTURE:
 *   - A `.ts` sibling of `GoLiveButton.tsx` so the copy assembly and the blocked-state rule are
 *     unit-testable; the component is a shell that calls these four functions.
 *   - Reuses the EXISTING `ConfirmCopy` shape and the one `<ConfirmProvider>` dialog — the
 *     lifecycle adds no second dialog.
 *   - The dialog's body is the server's own sentence, so what the user is told and what the MCP
 *     would do come from one place.
 */

import type { ConfirmCopy } from '@core/kernel/lifecycle';
import type { Lifecycle, LifecycleWord } from '@core/kernel/object-lifecycle';

export type GoLivePreviewDto = {
  object: { kind: string; id: string; name: string; head: string; tier: string };
  ref: string;
  dependencies: { kind: string; id: string; name: string; lifecycle: Lifecycle }[];
  confirm: { title: string; body: string; confirmLabel: string };
  blocked: string | null;
};

export type LifecycleStatusDto = {
  object: { kind: string; id: string; name: string; head: string; tier: string };
  lifecycle: Lifecycle;
  word: LifecycleWord;
  tier: string;
};

const json = async (res: Response): Promise<unknown> => {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  // The body rides along so the button can render a coded refusal in the reader's language (useServerMessage).
  if (!res.ok) throw Object.assign(new Error(body?.error || `request failed (${res.status})`), { body });
  return body;
};

export async function fetchLifecycleStatus(kind: string, id: string): Promise<LifecycleStatusDto> {
  const res = await fetch(`/api/lifecycle?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`, {
    cache: 'no-store',
  });
  return (await json(res)) as LifecycleStatusDto;
}

export async function fetchGoLivePreview(kind: string, id: string, sha?: string): Promise<GoLivePreviewDto> {
  const q = new URLSearchParams({ kind, id, action: 'preview' });
  if (sha) q.set('sha', sha);
  return (await json(await fetch(`/api/lifecycle?${q}`, { cache: 'no-store' }))) as GoLivePreviewDto;
}

export async function postGoLive(kind: string, id: string, sha?: string): Promise<unknown> {
  return json(
    await fetch('/api/lifecycle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'go_live', kind, id, ...(sha ? { sha } : {}) }),
    }),
  );
}

export async function postRetire(kind: string, id: string): Promise<unknown> {
  return json(
    await fetch('/api/lifecycle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'retire', kind, id }),
    }),
  );
}

/**
 * The ONE confirm dialog's copy for going live. The server already wrote the sentence that
 * names what starts running; a blocked go-live becomes a dialog that NAMES the culprit and
 * offers only Close, because there is nothing useful to confirm.
 */
export function goLiveDialogCopy(preview: GoLivePreviewDto): ConfirmCopy {
  if (preview.blocked) {
    return {
      title: `“${preview.object.name}” cannot go live yet`,
      body: preview.blocked,
      confirmLabel: 'Close',
      danger: false,
    };
  }
  return {
    title: preview.confirm.title,
    body: preview.confirm.body,
    confirmLabel: preview.confirm.confirmLabel,
    danger: false,
  };
}

/** Retire's copy — the same dialog, and it says in words that nothing is deleted. */
export function retireDialogCopy(name: string, kind: string): ConfirmCopy {
  return {
    title: `Retire “${name}”?`,
    body: `Run stops serving ${kind} “${name}”. Nothing is deleted — the draft, its history and every version stay exactly as they are, and you can go live again at any time.`,
    confirmLabel: 'Retire',
    danger: false,
  };
}

/**
 * The button's own label — the only new control the lifecycle puts on screen, in its two states.
 *
 * Review L-1: there is no third 'Live' label. A live object with no unpublished edits has nothing
 * to go live WITH, so the control is `Retire`; a live object whose draft has moved on offers
 * `Go live with this draft`. The badge, not the button, is where "this is Live" is stated.
 */
export function goLiveButtonLabel(word: LifecycleWord, hasUnpublished: boolean): string {
  if (word === 'live') return hasUnpublished ? 'Go live with this draft' : 'Retire';
  return 'Go live';
}

// ------------------------------------------------------------- i18n twins ---
/** A `common`-namespace message (i18n wave 4). */
export type GoLiveMessage = { key: string; args?: Record<string, string> };

/** The `common` key of {@link goLiveButtonLabel}'s word; the English catalog equals it. */
export function goLiveButtonLabelMessage(word: LifecycleWord, hasUnpublished: boolean): GoLiveMessage {
  if (word === 'live') return { key: hasUnpublished ? 'lifecycle.goLive.withDraft' : 'lifecycle.goLive.retire' };
  return { key: 'lifecycle.goLive.goLive' };
}

/** {@link goLiveDialogCopy} with the OS's own words translated. The server-written sentences (the preview's confirm
 *  copy and the blocked reason) are shown as the server sent them. */
export function goLiveDialogCopyIn(preview: GoLivePreviewDto, text: (m: GoLiveMessage) => string): ConfirmCopy {
  const copy = goLiveDialogCopy(preview);
  if (!preview.blocked) return copy;
  return {
    ...copy,
    title: text({ key: 'lifecycle.goLive.blockedTitle', args: { name: preview.object.name } }),
    confirmLabel: text({ key: 'lifecycle.goLive.close' }),
  };
}

/** {@link retireDialogCopy} in the reader's language. */
export function retireDialogCopyIn(name: string, kind: string, text: (m: GoLiveMessage) => string): ConfirmCopy {
  return {
    title: text({ key: 'lifecycle.goLive.retireTitle', args: { name } }),
    body: text({ key: 'lifecycle.goLive.retireBody', args: { name, kind } }),
    confirmLabel: text({ key: 'lifecycle.goLive.retire' }),
    danger: false,
  };
}
