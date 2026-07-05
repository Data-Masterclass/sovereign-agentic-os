import type { GoldenPathKey } from '@/lib/tutorials/types';
import TutorialLink from '@/components/tutorials/TutorialLink';
import McpDrawer from '@/components/McpDrawer';

/**
 * Shared page header: topbar (title + crumb + Live pill + global MCP button)
 * + optional ActionBar for tutorial shortcuts.
 *
 * Layout after Phase-7 follow-up:
 *   TOP-RIGHT topbar-actions: Live-cluster pill · "Connect your AI Tool via MCP"
 *     — global button, present on EVERY page, targets the overarching /api/mcp
 *       endpoint (all 33+ golden-path tools across every tab).
 *   TOP-LEFT ActionBar: Tutorial button only (when `tutorial` is provided).
 *     — per-tab MCP buttons were removed; the global topbar button supersedes them.
 */
export default function PageHeader({
  title,
  crumb,
  tutorial,
}: {
  title: string;
  crumb?: string;
  /** If set, shows a tutorial button in the ActionBar for this golden path. */
  tutorial?: GoldenPathKey;
}) {
  return (
    <>
      <div className="topbar">
        <div>
          <h1>{title}</h1>
          {crumb ? <div className="crumb">{crumb}</div> : null}
        </div>
        <div className="topbar-actions">
          <McpDrawer className="topbar-mcp-btn" />
          <span className="pill">
            <span className="live" />
            Live cluster
          </span>
        </div>
      </div>

      {tutorial && (
        <div className="action-bar">
          <TutorialLink tutorial={tutorial} variant="action-bar" />
        </div>
      )}
    </>
  );
}
