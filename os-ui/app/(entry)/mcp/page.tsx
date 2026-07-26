/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import PageHeader from '@/components/PageHeader';
import McpToolsClient from '@/components/McpToolsClient';
import { buildFullCatalog } from '@/lib/agents/tool-catalog';

/**
 * MCP reference page — a teaching surface for the cohort.
 *
 * Shows what the OS MCP endpoint is, how to connect any AI tool to it, and the
 * complete governed tool catalog: every tool grouped by area, with its
 * description, minimum role, and whether it requires approval.
 *
 * Uses a server component to pull the full tool catalog at render time (from the
 * same canonical registry the live MCP server consults), then hands off to the
 * client component for search/filter interactivity. This means the reference
 * can never drift from the real tool list.
 */
export default function McpPage() {
  const catalog = buildFullCatalog();

  return (
    <>
      <PageHeader
        title="MCP"
        crumb="AI tool integration · connect Claude & ChatGPT · governed tool reference"
      />
      <div className="content">
        <p className="lead">
          The Sovereign OS exposes a single authenticated{' '}
          <strong>remote MCP endpoint</strong> — one import in Claude, ChatGPT,
          or any MCP-compatible AI tool, and you drive the whole OS from your
          assistant. Every call runs under <em>your</em> identity through the
          same governed path as the UI: OPA policy, Langfuse audit, and role
          gates apply unchanged. Your tools are scoped to your role; write
          operations may be held in the Governance queue.
        </p>

        <McpToolsClient tools={catalog} />
      </div>
    </>
  );
}
