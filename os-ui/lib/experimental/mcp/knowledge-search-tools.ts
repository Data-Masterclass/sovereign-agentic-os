/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { McpTool } from '@/lib/mcp/server';
import { fail, str } from '@/lib/mcp/write-common';
import { retrieveKnowledge } from '@/lib/experimental/knowledge/retrieve';

/** #28: extracted from server.ts so it stops statically importing
 *  `@/lib/experimental/knowledge/retrieve` (knowledge tab, non-base). */
export const knowledgeSearchTools: McpTool[] = [
  {
    name: 'search_knowledge',
    description:
      'Governed hybrid knowledge retrieval (dense + lexical, reranked) with provenance for citations. Runs the same OPA `retrieve` gate + document-level grant filter as the Knowledge tab — you only ever see units you are entitled to.',
    minRole: 'creator',
    tab: 'knowledge',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to retrieve.' },
        k: { type: 'number', description: 'Max hits (default 6, capped at 20).' },
      },
      required: ['query'],
    },
    call: async (user, args) => {
      const query = str(args.query).trim();
      if (!query) fail('search_knowledge needs a `query` string', 400);
      const k = typeof args.k === 'number' && args.k > 0 ? Math.min(Math.floor(args.k), 20) : undefined;
      return retrieveKnowledge(
        query,
        { id: user.id, domains: user.domains, role: user.role },
        k ? { k } : {},
      );
    },
  },
];
