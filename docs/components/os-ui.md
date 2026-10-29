# OS UI — the front door

**What it is:** The Next.js (app-router) **front door** of the OS — the single pane a
business user opens. As of **v1.0 every sidebar tab is a real surface** (no "soon" stubs):
the left sidebar carries the canonical OS tabs plus a **Platform** group, and each one calls
its in-cluster backend through **server-side API routes**, so credentials/keys never reach the
browser. Backend URLs are env-configurable (defaults = in-cluster Service names).

## Access (UI)
```bash
kubectl -n agentic-os port-forward svc/os-ui 8080:3000
# http://localhost:8080  (no login locally)
```

## Live surfaces (v1.0 — every tab is wired)
| Tab | Wiring |
|---|---|
| **Home** | live **stack-status strip** (`/api/status` probes ~8 backends) + **executable golden-path cards** that deep-link to where each path runs (Agents, Data, Dashboards, Software, Science) |
| **Strategy** | strategic pillars + an agentic-transformation readiness heatmap — **seeded v1** planning workspace |
| **Big Bets** | strategic AI bets (thesis · target value · confidence · backing artifacts) — **seeded v1** planning workspace |
| **Dashboards** | launch into Superset (env-configurable URL) |
| **Agents** | lists the deployed **LangGraph** agents with live health (`/api/agents`) + an **agent-builder chat** (`/api/agent-chat` → LiteLLM); agent codegen/deploy is a **draft** for review |
| **Software** | `/api/software` → Forgejo: lists repos + recent **CI runs**, and **creates a real repo** (starter Dockerfile + CI workflow + k8s manifest → push → CI → Argo deploy) |
| **Science** | **Layer-4 launchpad** — health + links for **MLflow / JupyterHub / Featureform / KServe** (off by default, opt-in) |
| **Knowledge** | a **knowledge agent** interviews you and authors a 3-category `.md` (**workflow steps · rules & decisions · tacit context**), then **ingests** it to OpenSearch; plus lexical search over the `knowledge` index |
| **Structured Data** | **talk-to-your-data RAG chat** (moved here from Agents → sample-agent `/ask`), **SQL query** (query-tool), a **catalog** (OpenMetadata, falls back to query-tool), and a per-data-product **dbt agent** (draft) |
| **Metrics** | `/api/metrics` → Cube semantic layer (`daily_revenue` measures/dimensions) |
| **Unstructured Data** | document **library** (OpenSearch), **upload/paste → LLM classify & describe** (LiteLLM, `/api/classify`) then curate into Knowledge, plus a sources/connector scaffold |
| **Connections** | a **connections agent** drafts connector configs + a connector catalog (OneDrive/SharePoint/Drive/S3/upload); connector-build is a **draft** |
| **Marketplace** | seeded catalog of installable components/agents/templates/datasets/connectors (installed vs available) — **seeded v1** |
| **Monitoring** | `/api/traces` → Langfuse public API → recent agent traces |
| **Governance** | `/api/policy` → OPA → the grants matrix (principal × tool, default-deny), each cell re-verified live |
| **Settings** | deployment identity + enabled components, and **Appearance** (the light/dark theme toggle, persisted per device) |
| **Components** (Platform) | **native stack operator** — reads the Kubernetes API directly, server-side — see below |
| **Gateway** (Platform) | `/api/gateway` → LiteLLM → available models + registered MCP tools |
| **Orchestration** (Platform) | `/api/orchestration` → Dagster GraphQL → assets + runs |
| **Consoles** (Platform) | launchpad cards for the full external tool UIs (port-forward cmd + URL + dev login) |
| **About / Licenses** (Platform) | the bundled open-source components grouped by SPDX license |

**What's real vs scaffolded.** The status, query, RAG, classify, knowledge-ingest, repo-create,
gateway, policy, traces, metrics and Components surfaces are **live** against the cluster.
Marketplace, Strategy and Big Bets are **seeded v1** workspaces. The agent-builder, dbt-product,
connections and software-builder chats produce **draft specs for review**, not live deploys. All
backend calls are **server-side** — no secrets reach the browser.

## Platform → Components — native stack operator
The **Components** tab operates the whole stack from **inside the OS UI**. It reads the Kubernetes
API **directly, server-side** (`/api/platform/components`, `/api/platform/toggle`,
`/api/platform/doc`) via a scoped ServiceAccount, so the browser never holds the Kubernetes token.
It shows **live status for all components grouped by layer**, **on/off toggles** (scale 0↔1; "core"
items aren't toggleable), and each component's **address + login + docs** (rendered in a drawer).
No separate console service is deployed — this tab is the single operator surface.

## Theming (brand · light/dark)
The UI is styled to **www.sovereign-agentic.com**: the gold accent **`#c8a24a`** (→ `#e7cd86`)
with teal as the secondary accent, the gold **lotus** logo/favicon (`app/icon.svg`), and the
brand type system — **Oswald** (headings) / **Marcellus** (eyebrows) / **Rubik** (body),
self-hosted via `next/font` (offline-safe, no runtime CDN). **Light mode is the default** (white
content area, black + gold text); the **sidebar and top bar stay black in both modes**. **Dark
mode** (`[data-theme='dark']`, dark `#0c0b0d` palette + faint hero glow) is opt-in via
**Settings → Appearance**, and the choice persists per device (`localStorage`, applied pre-paint).

## FAQ
**Q: Is this the whole product UI?** Yes for navigation — v1.0 makes **every tab a real surface**.
Per-domain spaces and identity (Ory) are the next build (`build-ui.md`).
**Q: Where are the keys?** Server-side only. Langfuse/Forgejo/LiteLLM credentials and the k8s token
(for Components) are read from existing Secrets and never shipped to the browser.
**Q: How do I point a surface at a different backend?** Every backend URL is an env value (the
`osUI.*` chart values: `forgejoUrl`, `opaUrl`, `litellmUrl`, `dagsterUrl`, `cubeUrl`,
the console URLs, …) — override per environment (e.g. Ingress hosts) in values.
