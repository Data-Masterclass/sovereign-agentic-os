/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The large agent editor — one agent opened big, so its prompt has room to breathe
 * USER STORY: As a builder I double-click an agent card (or press its Edit button) and get a
 *             near-full-screen editor where the instructions take most of the screen, with the
 *             role, memory, tools and model alongside; Cmd/Ctrl+S saves and Esc closes.
 * ARCHITECTURE:
 *   - A modal shell only. The content is `AgentEditor` with `variant="large"` — the same
 *     sections and the same save paths (MonacoFile files PUT, `commitSystem` for system.yaml).
 *   - Keyboard + focus rules come from `lib/agent-editor-view.ts` (unit-tested): Esc → close
 *     (asks first via the shared ConfirmDialog when a file has unsaved edits), Cmd/Ctrl+S →
 *     save the file on screen (and a role draft), Tab is trapped inside the dialog, focus
 *     returns on close. Esc/Tab run after Monaco (bubble phase) so its widgets keep them.
 *   - The confirm sits above the dialog via the `--z-*` overlay tokens (tokens-base.css).
 *   - Opened from the Developer canvas (double-click / Edit on a node, or the drawer's
 *     "Large editor") and from the Simple builder's agent cards. Needs a <ConfirmProvider>
 *     above it (SystemView provides one).
 */
'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import AgentEditor from '@tabs/agents/ui/AgentEditor';
import { type System } from '@tabs/agents/lib/system-schema';
import { useConfirm } from '@core/ui/lifecycle/ConfirmDialog';
import { editorKeyIntent, trapTabIndex, unsavedCloseMessages, FOCUSABLE_SELECTOR } from '@tabs/agents/lib/agent-editor-view';
import { useTranslations, useLocale } from '@core/i18n/client';

export default function AgentEditorDialog({
  systemId,
  system,
  agentId,
  canEdit,
  isEntrypoint,
  onSetEntrypoint,
  onChanged,
  onClose,
  initialDrafts,
}: {
  systemId: string;
  system: System;
  agentId: string;
  canEdit: boolean;
  isEntrypoint?: boolean;
  onSetEntrypoint?: () => void;
  onChanged: () => void | Promise<void>;
  onClose: () => void;
  /** Unsaved buffers carried in from the drawer (path → text). */
  initialDrafts?: Record<string, string>;
}) {
  const confirm = useConfirm();
  const t = useTranslations('agents');
  const locale = useLocale();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const saveRef = useRef<(() => Promise<void>) | null>(null);
  const [full, setFull] = useState(false);
  const [unsaved, setUnsaved] = useState<string[]>([]);
  const unsavedRef = useRef(unsaved);
  unsavedRef.current = unsaved;
  const confirming = useRef(false);

  const requestClose = useCallback(async () => {
    if (confirming.current) return;
    if (unsavedRef.current.length > 0) {
      confirming.current = true;
      const m = unsavedCloseMessages(unsavedRef.current, t('editor.unsaved.theRole'), locale);
      const list = m.listKey ? t('editor.unsaved.thisFile') : (m.body.args?.list ?? '');
      const ok = await confirm({
        title: t('editor.unsaved.title'),
        body: t('editor.unsaved.body', { list }),
        confirmLabel: t('editor.unsaved.confirm'),
        danger: true,
      });
      confirming.current = false;
      if (!ok) {
        dialogRef.current?.focus();
        return;
      }
    }
    onClose();
  }, [confirm, onClose, t, locale]);

  // Focus in on open; on close back to the opener — or, when the opener unmounted
  // (the drawer hides while the dialog is up), to the drawer's "Large editor" button
  // once it re-renders. Page scroll is locked meanwhile.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
      if (opener?.isConnected) opener.focus();
      else requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-agent-editor-return]')?.focus());
    };
  }, []);

  useEffect(() => {
    // CAPTURE: Cmd/Ctrl+S must beat the browser's "Save page" (and Monaco). While the
    // unsaved-changes confirm is up it is swallowed, not passed to the browser.
    const onCapture = (e: KeyboardEvent) => {
      if (editorKeyIntent(e) !== 'save') return;
      e.preventDefault();
      if (!confirming.current) void saveRef.current?.();
    };
    // BUBBLE: Esc and Tab run AFTER Monaco, so Esc first closes Monaco's find/suggest
    // widget (Monaco consumes it) and Tab still indents inside the editor.
    const onBubble = (e: KeyboardEvent) => {
      if (confirming.current || e.defaultPrevented) return;
      if (editorKeyIntent(e) === 'close') {
        e.preventDefault();
        void requestClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = dialogRef.current;
      if (!root) return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      const target = trapTabIndex(items.length, items.indexOf(document.activeElement as HTMLElement), e.shiftKey);
      if (target !== null) {
        e.preventDefault();
        items[target]?.focus();
      }
    };
    document.addEventListener('keydown', onCapture, true);
    document.addEventListener('keydown', onBubble);
    return () => {
      document.removeEventListener('keydown', onCapture, true);
      document.removeEventListener('keydown', onBubble);
    };
  }, [requestClose]);

  // Undo/redo typed in the dialog stays in the dialog: Monaco handles it at its own
  // input first, then we stop it here so the page's system.yaml undo (SystemView's
  // window listener) never rewinds a commit behind the modal.
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return undefined;
    const stop = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && (k === 'z' || k === 'y')) e.stopPropagation();
    };
    el.addEventListener('keydown', stop);
    return () => el.removeEventListener('keydown', stop);
  }, []);

  return (
    <div
      className={`agent-large-scrim${full ? ' is-full' : ''}`}
      role="presentation"
      onMouseDown={(e) => { if (e.target === e.currentTarget) void requestClose(); }}
    >
      <div
        ref={dialogRef}
        className={`agent-large${full ? ' is-full' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <AgentEditor
          variant="large"
          titleId={titleId}
          systemId={systemId}
          system={system}
          agentId={agentId}
          canEdit={canEdit}
          isEntrypoint={isEntrypoint}
          onSetEntrypoint={onSetEntrypoint}
          onChanged={onChanged}
          onClose={() => void requestClose()}
          onDirtyChange={setUnsaved}
          saveRef={saveRef}
          initialDrafts={initialDrafts}
          headActions={
            <button
              className="btn ghost sm agent-large-full-btn"
              aria-pressed={full}
              onClick={() => setFull((v) => !v)}
              title={full ? t('editor.fullScreen.leaveTitle') : t('editor.fullScreen.enterTitle')}
            >
              {full ? t('editor.fullScreen.leave') : t('editor.fullScreen.enter')}
            </button>
          }
        />
      </div>
    </div>
  );
}
