/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    "Ask the OS" launcher state — idle, working, or answer ready
 * USER STORY: As a user who left Home while the OS was still answering, I want the "Ask the OS" button
 *             to show that it is working, and then that an answer is ready, without opening the panel.
 * ARCHITECTURE:
 *   - Pure, DOM-free view model over the chat session snapshot (`core/ui/chat-session.ts`);
 *     `core/ui/OsAssistant.tsx` renders it, `chat-launcher.test.ts` drives it under `node --test`.
 *   - On Home the inline chat is the surface, so the floating launcher is hidden there (unchanged).
 */
import type { ChatSnapshot } from '@core/ui/chat-session';

export const LAUNCHER_NAME = 'Ask the OS';

export type LauncherState = 'idle' | 'working' | 'ready';

export type LauncherView = {
  visible: boolean;
  state: LauncherState;
  /** The button's accessible name. */
  ariaLabel: string;
  /** Short visible suffix after the name ("working…", "answer ready"), empty when idle. */
  badge: string;
  /** Text for the polite live region next to the button; empty when there is nothing to announce. */
  announce: string;
};

export function launcherView(snap: Pick<ChatSnapshot, 'busy' | 'ready'>, pathname: string, panelOpen: boolean): LauncherView {
  const state: LauncherState = snap.busy ? 'working' : snap.ready ? 'ready' : 'idle';
  const badge = state === 'working' ? 'working…' : state === 'ready' ? 'answer ready' : '';
  return {
    visible: !panelOpen && pathname !== '/',
    state,
    ariaLabel: badge ? `${LAUNCHER_NAME} — ${badge}` : LAUNCHER_NAME,
    badge,
    announce: badge ? `${LAUNCHER_NAME} — ${badge}` : '',
  };
}
