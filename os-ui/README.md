# Sovereign Agentic OS — os-ui

The Next.js (App Router + TypeScript) application: the OS shell, all 13 tabs, the API
routes behind them, and the MCP server. Credentials stay server-side — the browser and
the model never see a key.

To run the whole OS locally, use the repo root: `./scripts/os up`. This file covers the
app itself.

## Tabs

| Group | Tabs |
|---|---|
| Entry | Home · MCP · About / Licenses |
| Context | Data · Metrics · Files · Knowledge |
| Build | **Workflows** · Agents · Dashboards · Software |
| Manage | Connections · Governance · Monitoring · Admin |

Every tab is reachable from the UI and from MCP with the same permissions. Each declares
its routes, APIs, MCP tools and required services in `tabs/<tab>/manifest.ts`;
`OS_ENABLED_TABS` decides which appear.

## Layout

```
core/   the kernel every tab depends on (never imports a tab)
tabs/   one folder per tab: manifest.ts · lib/ · ui/ · mcp/ · guide.md · context.md
app/    the Next.js route tree — pages import @core/* and @tabs/*
```

See **ARCHITECTURE.md** for the rules and how CI enforces them.

## Develop

```bash
npm install
npm run dev     # http://localhost:3000
npm run build   # production build (output: 'standalone')
npm test        # 4,700+ tests across core/ and tabs/
bash scripts/gate.sh   # the regression gate (the five reviewed defects)
```

From the repo root: `node scripts/check-structure.mjs` (layout ratchet) and
`node scripts/build-docs.mjs` (the code map).

## Deploy

Built by `images/base/os-ui/Dockerfile` (multi-stage, non-root, standalone) and deployed
by `charts/sovereign-agentic-os/templates/base/os-ui/os-ui.yaml`. The chart's
`values.yaml` is the laptop profile; `values.stackit-managed.yaml` overlays a cloud
install. Backend URLs default to in-cluster Service names (`core/kernel/config.ts`), so
the same image runs locally and in a cluster.

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

## Env vars

All optional; every default is the in-cluster Service name. `core/kernel/config.ts` is the
single source of truth — read it rather than a table that drifts. The chart sets them in
`templates/base/os-ui/os-ui.yaml`; the ones you are most likely to change are
`OPENSEARCH_URL`, `LITELLM_URL`, `OPA_URL`, `AGENT_RUNTIME_URL`, `OS_ENABLED_TABS` and
`OS_PUBLIC_URL`.
