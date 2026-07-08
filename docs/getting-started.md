# Sovereign Agentic OS — Getting started

The Sovereign Agentic OS is a self-hostable, EU-sovereign platform that assembles ~25
best-in-class open-source tools (LangGraph, LiteLLM, Langfuse, OpenSearch, dbt, Dagster,
Cube, Superset, Forgejo, Argo CD, Iceberg/Polaris/Trino, OPA…) into one governed stack
where every business **domain** can create, store, use, document and share data, knowledge,
dashboards, agents and software.

## Layers
- **Layer 1 — Agent core:** LangGraph agents · LiteLLM gateway · Langfuse tracing · OpenSearch retrieval.
- **Layer 2 — Context:** OPA · Docling · Haystack · Dagster · dbt · Cube · OpenMetadata.
- **Layer 3 — Self-service:** Iceberg lakehouse (Polaris + central Trino — the single governed query engine) · Superset BI · Forgejo + Argo CD.
- **Security baseline:** default-deny egress · egress proxy · governed OPA-gated `web_fetch`.

## Install (local, kind)
```bash
kind create cluster --name agentic-os
./install.sh            # Enter through every prompt = fully self-contained
```
`install.sh` builds the images, bootstraps operators, installs the chart, seeds demo data,
and prints the demo logins. Non-interactive: `./install.sh --defaults`. Remove:
`./install.sh --uninstall`.

## Deploy to STACKIT (recommended: single node)

Ready to run it in the cloud? Follow the **primary, verified path**:
**[Deploy to STACKIT — recommended: single node](stackit-deployment-guide.md)**. One `g2i.8`
node (8 vCPU / 32 GB) in a single availability zone, every backend self-contained in-cluster,
TLS via Let's Encrypt, and `deploy/stackit off` to pause the whole stack off-hours. Managed
services (Mode B) and multi-node HA are **known-blocked** on STACKIT today (cross-node pod
networking on SKE-in-an-SNA is broken — see the guide's Cautions); single node is the only
verified path.

## Two front doors
**OS UI** — the product front door. **v1.0: every sidebar tab is a real surface** (Home, Agents,
Structured Data with talk-to-your-data, Knowledge, Software, Science, Metrics, Governance,
Gateway, Orchestration, Dashboards, and more), styled to the **Sovereign Agentic** brand. **Light
mode is the default** (toggle to dark in Settings → Appearance). The Admin Console is also embedded
here under **Platform → Components**.
```bash
kubectl -n agentic-os port-forward svc/os-ui 8080:3000        # http://localhost:8080
```
**Admin Console** — operate the stack (status, on/off, addresses, logins + these docs); also
embedded in the OS UI at Platform → Components:
```bash
kubectl -n agentic-os port-forward svc/admin-console 8081:8080   # http://localhost:8081
```

## The demo data that ships
- A **knowledge** index in OpenSearch (the agents' RAG).
- A **dbt warehouse** (`analytics.daily_revenue`) read by Cube + Superset.
- **Iceberg marts** (`analytics.daily_revenue`) on object storage, queryable through central Trino.
- A **Langfuse** project (`agent-core`) with API keys.
- A **Forgejo** repo (`demo-app`) with a CI workflow (**push → Forgejo Actions → CI runner**)
  that **Argo CD** deploys into the `demo` namespace.

## FAQ
**Q: Where do I log in first?** Langfuse — `admin@datamasterclass.com` /
`langfuse-local-dev-admin`. It's the default Administrator-style console (traces, evals).

**Q: Is there one unified UI?** Yes — the Next.js **OS UI** is the unified front door, and as of
v1.0 every sidebar tab is a real surface (the Admin Console itself is embedded under Platform →
Components). Each tool's own console is still reachable directly (all linked from the Consoles tab).

**Q: How do I turn off something to save memory?** Use the on/off toggle on its card
(scales it to 0). To remove it permanently, set `<component>.enabled: false` in your values.

**Q: Are the passwords here safe?** They are **local dev throwaways** (profile `local`). On
STACKIT every secret is external (Secrets Manager + External Secrets) — see Cloud config.
