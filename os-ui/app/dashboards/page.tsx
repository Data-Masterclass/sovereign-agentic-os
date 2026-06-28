import PageHeader from '@/components/PageHeader';
import { config } from '@/lib/config';

// Server component: reads the Superset URL from server config and hands the
// browser a plain link (Superset has its own auth + session).
export default function DashboardsPage() {
  const url = config.supersetUrl;
  return (
    <>
      <PageHeader title="Dashboards" crumb="Superset BI on Cube metrics" />
      <div className="content">
        <p className="lead">
          Build and view dashboards in Superset, on top of your governed metrics. In a
          later iteration these embed inline; for now they open in Superset.
        </p>

        <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span className="ico" style={{ fontSize: 22, color: 'var(--teal)' }}>
            ▦
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600 }}>Superset</div>
            <div className="muted mono">{url}</div>
          </div>
          <a className="btn" href={url} target="_blank" rel="noreferrer">
            Open Superset →
          </a>
        </div>

        <div className="hint">
          Set <code>SUPERSET_URL</code> to your Superset address (default points at the
          local port-forward <code>http://localhost:8088</code>).
        </div>
      </div>
    </>
  );
}
