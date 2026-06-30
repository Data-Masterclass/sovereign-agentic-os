# Sovereign Agentic OS UI

The Next.js (app router + TypeScript) **front door** for the Sovereign Agentic OS: the OS
shell (left sidebar with the canonical tabs from `stackit/os-application.md`, plus a
**Platform** group) with the surfaces wired to the **live in-cluster backends** via
**server-side API routes** — so credentials and project keys stay on the server and never
reach the browser.

## Tabs

| Tab | Status | Backend (server-side) |
|---|---|---|
| **Home** | live | overview + golden paths + a live **stack-status strip** (pings 8 backends) |
| **Agents** (Chat) | live | `sample-agent` `GET /ask?q=` → answer + retrieved source titles |
| **Knowledge** | live | OpenSearch `POST /{index}/_search` → ranked RAG hits (embedding excluded) |
| **Structured Data** | live | query-tool `POST /query` → columns/rows, + a clickable Iceberg table browser |
| **Software** | live | Forgejo `GET /api/v1/...` (basic auth) → repos + `demo-app` CI runs (push→CI→deploy) |
| **Monitoring** | live | Langfuse `GET /api/public/traces` (basic auth) → recent traces |
| **Governance** | live | OPA `grants` + `POST /v1/data/agentic/authz/allow` → live default-deny grants matrix |
| **Dashboards** | link | Superset (`SUPERSET_URL`) |
| **Gateway** (Platform) | live | LiteLLM `GET /v1/models` + `/v1/mcp/tools` (Bearer) → models + MCP tools |
| **Orchestration** (Platform) | live | Dagster GraphQL → dbt assets + recent runs |
| **Consoles** (Platform) | launchpad | Langfuse / Superset / Argo CD / OpenMetadata / Dagster / Forgejo access cards |
| Strategy, Big Bets, Science, Metrics, Unstructured Data, Connections, Marketplace, Settings | stub | shell placeholders |

## Architecture

```
browser ──> /api/status        ──> health-pings 8 backends (up/down strip)
        ──> /api/chat           ──> SAMPLE_AGENT_URL/ask?q=
        ──> /api/knowledge?q=   ──> OPENSEARCH_URL/{index}/_search
        ──> /api/query          ──> QUERY_TOOL_URL/query
        ──> /api/tables         ──> QUERY_TOOL_URL/query (catalog list)
        ──> /api/software       ──> FORGEJO_URL/api/v1/... (basic auth)
        ──> /api/gateway        ──> LITELLM_URL/v1/models + /v1/mcp/tools (bearer)
        ──> /api/policy         ──> OPA_URL/v1/data/grants + .../authz/allow
        ──> /api/orchestration  ──> DAGSTER_URL/graphql
        ──> /api/traces         ──> LANGFUSE_URL/api/public/traces (basic auth)
```

All credentials/keys stay server-side. Backend base URLs are env-configurable
(see `lib/config.ts`); defaults are the in-cluster Service names, so the same image runs
in-cluster and locally (pointed at port-forwards).

## Develop

```bash
npm install
npm run dev    # http://localhost:3000  (set the env vars below to reach real backends)
npm run build  # production build (output: 'standalone')
```

## Deploy

Built as `images/os-ui/Dockerfile` (multi-stage, non-root, standalone) and deployed by
`charts/sovereign-agentic-os/templates/os-ui/os-ui.yaml`. See **`INTEGRATION.md`** for the
exact `values.yaml` / build-images entries the chart owner must add (incl. the new
`osUI.*` keys for OpenSearch, Forgejo, LiteLLM, OPA, Dagster, and the console URLs).

## Authentication & onboarding (self-hosted, no email required)

The OS ships its own pragmatic identity store (`lib/users.ts`, an Ory-replaceable
seam). It is **secure by default** and, crucially, **works on a fresh clone with no
mail infrastructure**:

- **First run** seeds a single bootstrap admin (`admin` / `admin`, flagged
  `mustChangeCredentials`). On first login the operator is forced through
  `/onboarding/bootstrap` to set a real username, email and **strong password**
  (strength enforced server-side, `lib/password.ts`).
- **Completing setup auto-verifies the account** — the operator who holds the
  bootstrap credential is trusted, so **no email round-trip is required**. The
  default `admin/admin` identity is **deleted right then**, the operator is signed
  in as the new real admin and lands on **Home (`/`)**. There is no "check your
  email" step that can dead-end a fresh install.
- Passwords are **scrypt-hashed** (salted, never plaintext, never logged, never
  returned). A high-entropy **master recovery key** (hash only) can reset a
  locked-out admin via `/recover`.

### Optional email verification (opt-in, gated on a configured mailer)

Email verification is **off by default** and only turns on when you configure a
mailer. The OS sends mail through a small, dependency-free **pluggable mailer**
(`lib/mailer.ts`) with **two transports**, selected by config (**Graph > SMTP >
none**):

- **No mailer (default):** new/invited accounts are **active immediately**; the
  flow never dead-ends.
- **A mailer configured (opt-in):** later/invited accounts start unverified and
  receive a **real, branded verification email** (HTML). The single-use token's
  *hash* is stored on the user row (durable), so verification survives a restart.
  Verification is still **non-blocking** — an unverified user can sign in; verifying
  only confirms the address.

`OS_EMAIL_VERIFICATION=false` force-disables verification even with a mailer;
`OS_PUBLIC_URL` sets the absolute base for emailed links (else a same-origin path).

#### Transport 1 — Microsoft Graph (recommended for Microsoft 365)

Preferred for M365 because it **avoids SMTP basic auth, which Microsoft is
deprecating**. Sends via Graph `sendMail` using an OAuth2 **client-credentials**
app token (cached until expiry). One-time **Entra (Azure AD)** setup:

1. **Register an app** in Entra ID → *App registrations* (single tenant is fine).
2. Under *API permissions* add **Microsoft Graph → Application permission
   `Mail.Send`**, then **Grant admin consent**.
3. Create a **client secret** (*Certificates & secrets*) and supply it out-of-band
   into the `os-ui-graph` Secret (never commit it).
4. **Recommended hardening:** add an **Exchange Application Access Policy** that
   restricts this app to send **only as `support@datamasterclass.com`** (the
   `MAIL_FROM` mailbox), so the `Mail.Send` grant can't send as any other user.

| Var | Default | Notes |
|---|---|---|
| `GRAPH_TENANT_ID` | *(unset)* | Entra tenant (directory) id. All three Graph vars must be set to enable Graph. |
| `GRAPH_CLIENT_ID` | *(unset)* | App (client) id. |
| `GRAPH_CLIENT_SECRET` | *(unset)* | Client secret — **from the `os-ui-graph` Secret**, never logged. |
| `MAIL_FROM` | `support@datamasterclass.com` | Sending mailbox / From address. |

Helm: `osUI.graph.enabled: true` + `osUI.graph.tenantId/clientId/mailFrom`, and the
secret out-of-band into `os-ui-graph` (`GRAPH_CLIENT_SECRET`).

#### Transport 2 — generic SMTP relay (fallback)

Used when Graph is **not** configured and `SMTP_HOST` is set — a minimal built-in
SMTP client (STARTTLS or implicit TLS, optional AUTH LOGIN).

| Var | Default | Notes |
|---|---|---|
| `SMTP_HOST` | *(unset)* | Presence enables SMTP (when Graph is not set). |
| `SMTP_PORT` | `587` (or `465` when secure) | |
| `SMTP_SECURE` | `false` | `true` → implicit TLS (465); else STARTTLS on 587. |
| `SMTP_USER` | *(unset)* | AUTH LOGIN username (optional). |
| `SMTP_PASS` | *(unset)* | AUTH LOGIN password — **from the `os-ui-smtp` Secret**, never logged. |
| `SMTP_FROM` | `support@datamasterclass.com` | Sender address. |

Helm: `osUI.smtp.enabled: true` + `osUI.smtp.host/port/secure/user/from`, and the
password out-of-band into `os-ui-smtp` (`SMTP_PASS`). Both Secrets are
`optional: true` and off by default.

### Persistence

The user store is an authoritative in-process cache **plus a best-effort OpenSearch
mirror (`os-users`)**; only hashes ever reach the mirror. Every runtime mutation
(setup, create, verify, recovery) write-throughs, so **runtime-created accounts
survive a pod restart when OpenSearch is reachable** (the platform's existing
durable store — no new dependency). With OpenSearch unreachable the store is
in-memory only and resets on restart — the documented boundary; the `OS_USERS`
operator seed remains the way to pin accounts in that mode.

## Env vars (all optional; defaults = in-cluster Service names)

See `INTEGRATION.md` for the full table and a ready-to-run `docker run` command. The new
ones added in this build: `OPENSEARCH_URL`, `KNOWLEDGE_INDEX`, `FORGEJO_URL`,
`FORGEJO_USER`, `FORGEJO_PASSWORD`, `LITELLM_URL`, `LITELLM_MASTER_KEY`, `OPA_URL`,
`DAGSTER_URL`, plus browser-reachable console URLs (`LANGFUSE_CONSOLE_URL`,
`FORGEJO_CONSOLE_URL`, `ARGOCD_URL`, `OPENMETADATA_URL`, `DAGSTER_CONSOLE_URL`).
