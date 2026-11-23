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
 *     save the file on screen, Tab is trapped inside the dialog, focus returns on close.
 *   - Opened from the Developer canvas (double-click / Edit on a node, or the drawer's
 *     "Large editor") and from the Simple builder's agent cards. Needs a <ConfirmProvider>
 *     above it (SystemView provides one).
 */
'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import AgentEditor from '@tabs/agents/ui/AgentEditor';
import { type System } from '@tabs/agents/lib/system-schema';
import { useConfirm } from '@core/ui/lifecycle/ConfirmDialog';
import { editorKeyIntent, trapTabIndex, unsavedCloseCopy, FOCUSABLE_SELECTOR } from '@tabs/agents/lib/agent-editor-view';

export default function AgentEditorDialog({
  systemId,
  system,
  agentId,
  canEdit,
  isEntrypoint,
  onSetEntrypoint,
  onChanged,
  onClose,
}: {
  systemId: string;
  system: System;
  agentId: string;
  canEdit: boolean;
  isEntrypoint?: boolean;
  onSetEntrypoint?: () => void;
  onChanged: () => void | Promise<void>;
  onClose: () => void;
}) {
  const confirm = useConfirm();
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
      const ok = await confirm(unsavedCloseCopy(unsavedRef.current));
      confirming.current = false;
      if (!ok) {
        dialogRef.current?.focus();
        return;
      }
    }
    onClose();
  }, [confirm, onClose]);

  // Focus in on open, back to the opener on close; lock page scroll meanwhile.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
      opener?.focus?.();
    };
  }, []);

  // Esc / Cmd+S / Tab trap. Capture phase so Monaco cannot swallow Cmd+S before us;
  // ignored while the unsaved-changes confirm is up (it handles its own keys).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (confirming.current) return;
      const intent = editorKeyIntent(e);
      if (intent === 'save') {
        e.preventDefault();
        void saveRef.current?.();
        return;
      }
      if (intent === 'close') {
        e.preventDefault();
        void requestClose();
        return;
      }
      if (e.key !== 'Tab' || e.defaultPrevented) return;
      const root = dialogRef.current;
      if (!root) return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      const target = trapTabIndex(items.length, items.indexOf(document.activeElement as HTMLElement), e.shiftKey);
      if (target !== null) {
        e.preventDefault();
        items[target]?.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [requestClose]);

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
          headActions={
            <button
              className="btn ghost sm agent-large-full-btn"
              aria-pressed={full}
              onClick={() => setFull((v) => !v)}
              title={full ? 'Leave full screen' : 'Full screen'}
            >
              {full ? '⤡ Exit full screen' : '⤢ Full screen'}
            </button>
          }
        />
      </div>
    </div>
  );
}
