/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    React binding of the Ask the OS chat session
 * USER STORY: As a user I want Home and the Ask the OS panel to show the same live conversation.
 * ARCHITECTURE:
 *   - `useSyncExternalStore` over the module-level `chatSession` (`core/ui/chat-session.ts`). The server
 *     snapshot is the empty conversation, so SSR never reads (or shares) browser state.
 */
'use client';

import { useSyncExternalStore } from 'react';
import { chatSession, emptySnapshot, type ChatSnapshot } from '@core/ui/chat-session';

const SERVER_SNAPSHOT = emptySnapshot();

export function useChatSession(): ChatSnapshot {
  return useSyncExternalStore(chatSession.subscribe, chatSession.getSnapshot, () => SERVER_SNAPSHOT);
}

export { chatSession };
