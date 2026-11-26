/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Read your own Home chat conversations over MCP
 * USER STORY: As a user I want my AI client to find and reopen what I asked on Home — and nobody
 *             else's conversations, ever.
 * ARCHITECTURE: two read-only tools over `core/runtime/conversations.ts`; the caller's id is the
 *             only scope there is, so another user's conversation is simply "not found".
 */
import 'server-only';
import type { McpTool } from '@core/mcp/server';
import { ensureHydrated, getConversation, hasSummary, listConversations } from '@core/runtime/conversations';

const NO_ARGS = { type: 'object', properties: {}, examples: [{}] } as const;

export const CONVERSATION_TOOLS: McpTool[] = [
  {
    name: 'list_conversations',
    tab: 'meta',
    minRole: 'creator',
    description:
      'List YOUR Home chat conversations, newest first (id, title, last update, message count). Purpose: find a conversation to reopen. Governance: read-only; private by default — you only ever see your own, whatever your role.',
    inputSchema: NO_ARGS as unknown as McpTool['inputSchema'],
    call: async (user) => {
      await ensureHydrated();
      return { conversations: listConversations(user.id) };
    },
  },
  {
    name: 'get_conversation',
    tab: 'meta',
    minRole: 'creator',
    description:
      'Read one of YOUR Home chat conversations by id (the messages and a one-line trace of the tools that ran). Before: list_conversations. Governance: read-only; a conversation that is not yours answers not_found, exactly like one that does not exist.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The conversation id from list_conversations.' } },
      required: ['id'],
      examples: [{ id: 'c-0123456789abcdef' }],
    } as unknown as McpTool['inputSchema'],
    call: async (user, args) => {
      await ensureHydrated();
      const id = typeof args.id === 'string' ? args.id : '';
      const c = getConversation(user.id, id);
      if (!c) {
        const e = new Error(`No conversation ${id || '(none)'} of yours`) as Error & { status?: number };
        e.status = 404;
        throw e;
      }
      return { id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, messages: c.messages, hasSummary: hasSummary(c) };
    },
  },
];
