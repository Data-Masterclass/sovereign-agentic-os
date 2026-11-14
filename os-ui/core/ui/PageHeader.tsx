import McpDrawer from '@tabs/admin/ui/McpDrawer';
import StudioRunToggle from '@core/ui/lifecycle/StudioRunToggle';

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
  return (
    <div className="topbar">
      <div>
        <h1>{title}</h1>
        {crumb ? <div className="crumb">{crumb}</div> : null}
      </div>
      <div className="topbar-actions">
        <StudioRunToggle />
        <McpDrawer className="topbar-mcp-btn" />
        <span className="pill">
          <span className="live" />
          Live cluster
        </span>
      </div>
    </div>
  );
}
