import McpDrawer from '@tabs/admin/ui/McpDrawer';

/**
 * Shared page header: topbar (title + crumb + Live pill + global MCP button).
 *
 * TOP-RIGHT topbar-actions: Live-cluster pill · "Connect your AI Tool via MCP"
 *   — global button, present on EVERY page, targets the overarching /api/mcp
 *     endpoint (all 33+ golden-path tools across every tab).
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
        <McpDrawer className="topbar-mcp-btn" />
        <span className="pill">
          <span className="live" />
          Live cluster
        </span>
      </div>
    </div>
  );
}
