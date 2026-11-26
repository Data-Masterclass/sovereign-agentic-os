/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Agent chat response parsing (re-export)
 * USER STORY: As a user I want a dead model backend to show a readable message, never a raw exception.
 * ARCHITECTURE:
 *   - The implementation moved to `core/runtime/chat-response.ts` so the kernel's chat session
 *     (`core/ui/chat-session.ts`) can use it without importing a tab. Kept so tab code and its
 *     test keep their import path.
 */
export { parseAgentChatResponse, stripThinking, type AgentChatParsed } from '@core/runtime/chat-response';
