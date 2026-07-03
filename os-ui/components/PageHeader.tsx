import type { GoldenPathKey } from '@/lib/tutorials/types';
import TutorialLink from '@/components/tutorials/TutorialLink';
import McpDrawer from '@/components/McpDrawer';

/**
 * Shared page header: topbar (title + crumb + Live pill) + optional ActionBar.
 *
 * The ActionBar sits below the topbar at the TOP-LEFT of the content area —
 * bigger, clearly visible primary actions for course participants. All 37 pages
 * that render PageHeader inherit it automatically.
 *
 * Rules (from plan C.7):
 *   - MCP button ("Connect your AI Tool via MCP") only on the 5 real MCP tabs
 *     (data, knowledge, agents, software, science) — pass `mcpTab` only there.
 *   - Tutorial button on every tab that has a golden-path tutorial — pass `tutorial`.
 *   - ActionBar only renders when at least one button is present.
 *   - Live-cluster pill stays in the topbar-actions (top-right), unchanged.
 */
export default function PageHeader({
  title,
  crumb,
  tutorial,
  mcpTab,
}: {
  title: string;
  crumb?: string;
  /** If set, shows a tutorial button in the ActionBar for this golden path. */
  tutorial?: GoldenPathKey;
  /** If set, shows a "Connect your AI Tool via MCP" button in the ActionBar. */
  mcpTab?: string;
}) {
  const hasActionBar = !!(mcpTab || tutorial);

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{title}</h1>
          {crumb ? <div className="crumb">{crumb}</div> : null}
        </div>
        <div className="topbar-actions">
          <span className="pill">
            <span className="live" />
            Live cluster
          </span>
        </div>
      </div>

      {hasActionBar && (
        <div className="action-bar">
          {mcpTab ? <McpDrawer tab={mcpTab} className="action-bar-btn" /> : null}
          {tutorial ? (
            <TutorialLink tutorial={tutorial} variant="action-bar" />
          ) : null}
        </div>
      )}
    </>
  );
}
