import Link from 'next/link';
import PageHeader from '@/components/PageHeader';
import StackStatus from '@/components/StackStatus';

const CAPABILITIES = [
  { k: 'Agent core', v: 'LangGraph', note: 'retrieve → generate → trace' },
  { k: 'Gateway', v: 'LiteLLM', note: 'one governed model + MCP endpoint' },
  { k: 'Retrieval', v: 'OpenSearch', note: 'hybrid vector + lexical' },
  { k: 'Lakehouse', v: 'DuckDB / Iceberg', note: 'governed query tool' },
  { k: 'Policy', v: 'OPA', note: 'default-deny tool authz' },
  { k: 'Observability', v: 'Langfuse v3', note: 'every action traced' },
];

// The five executable golden paths (os-application.md §6). Each deep-links into
// the tab that actually runs it against the live backend.
const GOLDEN = [
  { icon: '✦', label: 'Ask an agent', desc: 'See & build LangGraph multi-agent systems', href: '/agents', run: 'LangGraph + LiteLLM' },
  { icon: '▤', label: 'Query the lakehouse', desc: 'Talk to your data + run SQL over Iceberg', href: '/data', run: 'DuckDB / Iceberg' },
  { icon: '▦', label: 'Build a dashboard', desc: 'Compose charts on Cube metrics (Superset)', href: '/dashboards', run: 'Superset + Cube' },
  { icon: '⌘', label: 'Ship software', desc: 'Create a repo → CI → deploy with Forgejo', href: '/software', run: 'Forgejo + Argo CD' },
  { icon: '∿', label: 'Train a model', desc: 'Features → train → deploy via the ML agent', href: '/science', run: 'Featureform / MLflow / KServe' },
];

export default function HomePage() {
  return (
    <>
      <PageHeader title="Home" crumb="data-masterclass · domain overview" />
      <div className="content">
        <p className="lead">
          Your governed space on the Sovereign Agentic OS. Create, store, use, and
          document your data, knowledge, dashboards, and agents — under central
          governance, without touching Kubernetes or YAML.
        </p>

        <StackStatus />

        <div className="section-title">Capabilities</div>
        <div className="grid">
          {CAPABILITIES.map((s) => (
            <div className="card" key={s.k}>
              <h3>{s.k}</h3>
              <div className="big">{s.v}</div>
              <div className="muted">{s.note}</div>
            </div>
          ))}
        </div>

        <div className="section-title">Golden paths</div>
        <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
          Each path is executable — it deep-links into the tab that runs it against the live backend.
        </p>
        <div style={{ display: 'grid', gap: 12 }}>
          {GOLDEN.map((g) => (
            <Link className="golden" href={g.href} key={g.label}>
              <span className="ico">{g.icon}</span>
              <div>
                <div style={{ fontWeight: 600 }}>{g.label}</div>
                <div className="muted">{g.desc}</div>
              </div>
              <span className="chip" style={{ marginLeft: 'auto' }}>{g.run}</span>
              <span className="arr">→</span>
            </Link>
          ))}
        </div>
      </div>
    </>
  );
}
