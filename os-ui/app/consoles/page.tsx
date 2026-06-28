import PageHeader from '@/components/PageHeader';
import { config } from '@/lib/config';

// Server component: the launchpad for the full external tool consoles. These
// keep their own auth + session, so the OS UI links out rather than proxying.
// Each card carries the port-forward command + URL + dev login from the docs.

type Console = {
  name: string;
  glyph: string;
  blurb: string;
  url: string;
  forward: string;
  login?: string;
};

const CONSOLES: Console[] = [
  {
    name: 'Langfuse',
    glyph: '◷',
    blurb: 'Full tracing UI — evals, datasets, scores, per-span debugging.',
    url: config.langfuseConsoleUrl,
    forward: 'kubectl -n agentic-os port-forward svc/agentic-os-langfuse-web 3000:3000',
    login: 'admin@datamasterclass.com / langfuse-local-dev-admin',
  },
  {
    name: 'Superset',
    glyph: '▦',
    blurb: 'Self-service dashboards & SQL Lab on the dbt warehouse + Cube metrics.',
    url: config.supersetUrl,
    forward: 'kubectl -n agentic-os port-forward svc/agentic-os-superset 8088:8088',
    login: 'admin / superset-admin-local-dev',
  },
  {
    name: 'Argo CD',
    glyph: '⟜',
    blurb: 'GitOps deploys from Forgejo repos into per-domain namespaces.',
    url: config.argocdUrl,
    forward: 'kubectl -n agentic-os port-forward svc/argocd-server 8080:80',
    login: "admin / kubectl get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d",
  },
  {
    name: 'OpenMetadata',
    glyph: '❖',
    blurb: 'Data catalog + lineage (off by default locally — enable in the Admin Console).',
    url: config.openmetadataUrl,
    forward: 'kubectl -n agentic-os port-forward svc/openmetadata 8585:8585',
    login: 'admin@open-metadata.org / admin',
  },
  {
    name: 'Dagster',
    glyph: '⟲',
    blurb: 'Orchestrator UI — materialize dbt assets, inspect run logs.',
    url: config.dagsterConsoleUrl,
    forward: 'kubectl -n agentic-os port-forward svc/agentic-os-dagster-webserver 3070:80',
  },
  {
    name: 'Forgejo',
    glyph: '⌘',
    blurb: 'Sovereign Git hosting + Actions CI for the Software golden path.',
    url: config.forgejoConsoleUrl,
    forward: 'kubectl -n agentic-os port-forward svc/forgejo-http 3001:3000',
    login: 'gitea_admin / forgejo-admin-local-dev',
  },
];

export default function ConsolesPage() {
  return (
    <>
      <PageHeader title="Consoles" crumb="launchpad — the full external tool UIs" />
      <div className="content">
        <p className="lead">
          The OS shell wires the common surfaces in-app; deep, tool-native features still
          live in each tool&apos;s own console. These open the full UIs. URLs default to
          the local port-forward addresses and are env-configurable for any environment.
        </p>

        <div className="grid" style={{ marginTop: 16 }}>
          {CONSOLES.map((c) => (
            <div className="card launch-card" key={c.name}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <div className="row" style={{ alignItems: 'center', gap: 10 }}>
                  <span className="ico" style={{ fontSize: 18, color: 'var(--teal)' }}>{c.glyph}</span>
                  <h3 style={{ margin: 0 }}>{c.name}</h3>
                </div>
                <a className="btn ghost" href={c.url} target="_blank" rel="noreferrer">
                  Open →
                </a>
              </div>
              <div className="muted" style={{ marginTop: 8 }}>{c.blurb}</div>
              <div className="muted mono" style={{ marginTop: 8, fontSize: 11.5 }}>{c.url}</div>
              <div className="codeblock">{c.forward}</div>
              {c.login ? <div className="hint" style={{ marginTop: 8 }}>Login: {c.login}</div> : null}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
