/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    PageHeader — the shared page topbar (title, crumb, Studio/Run toggle, MCP button)
 * USER STORY: As a user on any page I want the page title and the global actions in the same
 *             place so that I can always find the MCP connect button and the Studio/Run switch.
 * ARCHITECTURE:
 *   - Used by the page routes under `app/`. Renders `StudioRunToggle` and `McpDrawer`
 *     (`tabs/admin/ui/McpDrawer`, targets `/api/mcp`).
 *   - The "Live cluster" pill is static markup; it does not check cluster status. Being decoration,
 *     it is hidden on phones (app/styles/mobile.css), where the title and actions wrap instead.
 * I18N:       converted (wave 1) — the Live pill from `shell.topbar.*`; the page title and crumb are the caller's (already translated) text.
 */
import McpDrawer from '@tabs/admin/ui/McpDrawer';
import StudioRunToggle from '@core/ui/lifecycle/StudioRunToggle';
import { useTranslations } from '@core/i18n/client';

/**
 * Shared page header: topbar (title + crumb + Live pill + global MCP button).
 *
 * TOP-RIGHT topbar-actions: the ONE Studio | Run toggle · Live-cluster pill ·
 *   "Connect your AI Tool via MCP" — global button, present on EVERY page,
 *   targets the overarching /api/mcp endpoint (all golden-path tools).
 *
 * The Studio | Run toggle is the lifecycle's whole header footprint (night 2,
 * stream V): Studio shows everything you can work on, Run only what the OS runs.
 * It is remembered per user and every tab's tile list reacts to it through the
 * one shared hook — no tab passes a surface down.
 */
export default function PageHeader({
  title,
  crumb,
}: {
  title: string;
  crumb?: string;
}) {
  const t = useTranslations('shell');
  return (
    <div className="topbar">
      <div>
        <h1>{title}</h1>
        {crumb ? <div className="crumb">{crumb}</div> : null}
      </div>
      <div className="topbar-actions">
        <StudioRunToggle />
        <McpDrawer className="topbar-mcp-btn" />
        <span className="pill topbar-live-pill">
          <span className="live" />
          {t('topbar.live')}
        </span>
      </div>
    </div>
  );
}
