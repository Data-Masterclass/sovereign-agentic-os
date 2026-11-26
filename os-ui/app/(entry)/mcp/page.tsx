/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * I18N:       converted (wave 2) — texts from `admin.mcpPage.*`.
 */
import PageHeader from '@core/ui/PageHeader';
import { useTranslations } from '@core/i18n/client';
import McpToolsClient from '@tabs/admin/ui/McpToolsClient';
import { buildFullCatalog } from '@tabs/agents/lib/tool-catalog';

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
  const t = useTranslations('admin');
  const catalog = buildFullCatalog();

  return (
    <>
      <PageHeader
        title="MCP"
        crumb={t('mcpPage.crumb')}

      />
      <div className="content">
        <McpToolsClient tools={catalog} />
      </div>
    </>
  );
}
