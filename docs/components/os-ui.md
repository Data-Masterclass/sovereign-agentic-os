# OS UI — the front door

**What it is:** the Next.js (App Router) application every user opens — the OS shell, all
13 tabs, the API routes behind them and the MCP server. Each surface calls its in-cluster
backend through **server-side** routes, so credentials never reach the browser or the
model. Backend URLs are env values defaulting to in-cluster Service names.

## Access

```bash
kubectl -n agentic-os port-forward svc/os-ui 8080:3000
# http://localhost:8080      locally: ./scripts/os up  →  http://localhost:8080
```

## The 13 tabs

| Group | Tab | Wiring |
|---|---|---|
| Entry | **Home** | live stack-status strip (`/api/status`) + golden-path cards that deep-link to where each path runs |
| Entry | **MCP** | mint and revoke the per-user MCP token; list the tools the caller's role exposes |
| Entry | **About / Licenses** | the bundled open-source components grouped by SPDX licence |
| Context | **Data** | datasets ingested through data-runner into Iceberg on MinIO, catalogued by Polaris, queried via Trino; build stages bronze → silver → gold → promote → certify, marts built by dbt |
| Context | **Metrics** | a metric is a frozen `<View>.<measure>` member on the Gold mart, compiled to governed Trino SQL under the viewer's identity |
| Context | **Files** | objects in MinIO, text extracted by Docling, folder-level grants |
| Context | **Knowledge** | a knowledge agent interviews you and authors a 3-category `.md` (workflow steps · rules & decisions · tacit context), indexed in OpenSearch with embeddings via LiteLLM |
| Build | **Workflows** | business workflows as governed, versioned artifacts |
| Build | **Agents** | build and run agent teams (LangGraph in agent-runtime); grants, safety presets, run traces |
| Build | **Dashboards** | native ECharts panels bound to one governed view, resolved through the same path as the metric explorer |
| Build | **Software** | app spec → design → generated files → preview → verify → deploy approval; versions are app-store revisions |
| Manage | **Connections** | connector configs (OneDrive · Outlook · Teams · Google Drive · Gmail · Kajabi · Notion MCP · Entra · SQL · any MCP server) with server-side credentials and governed egress |
| Manage | **Governance** | the approvals inbox (My → Domain → Company) plus the OPA grants matrix, each cell re-verified live |
| Manage | **Monitoring** | `/api/traces` → Langfuse → recent agent runs |
| Manage | **Admin** | users & access, platform settings, the Components operator, the LLM gateway, appearance |

Each tab declares its routes, APIs, MCP tools and required services in
`os-ui/tabs/<tab>/manifest.ts`. A tab whose services are disabled disappears from the
navigation instead of failing when clicked; `OS_ENABLED_TABS` gates the same set.

## Admin → Components — native stack operator

Operates the whole stack from inside the OS UI. It reads the Kubernetes API **directly,
server-side** (`/api/platform/components`, `/api/platform/toggle`, `/api/platform/doc`)
through a scoped ServiceAccount, so the browser never holds a cluster token. It shows live
status per component, on/off toggles (scale 0↔1; core items are not toggleable), and each
component's address, login and docs. No separate console service is deployed.

## Theming

Styled to www.sovereign-agentic.com: gold accent **`#c8a24a`** (→ `#e7cd86`) with teal
secondary, the gold lotus logo/favicon (`app/icon.svg`), and **Oswald** (headings) /
**Marcellus** (eyebrows) / **Rubik** (body), self-hosted via `next/font` — offline-safe, no
runtime CDN. Light mode is the default; the sidebar and top bar stay black in both modes.
Dark mode is opt-in via Admin → Appearance and persists per device.

## FAQ

**Where are the keys?** Server-side only. Langfuse, LiteLLM and the Kubernetes token are
read from existing Secrets and never shipped to the browser or put in a model prompt.

**How do I point a surface at a different backend?** Every backend URL is an env value —
see `os-ui/core/kernel/config.ts` for the authoritative list and the chart's
`templates/base/os-ui/os-ui.yaml` for where they are set.

**Is MCP a second implementation?** No. The MCP endpoint dispatches through the same
`core/mcp/handleRpc` and the same governed libraries as the UI, with the same role floors
and the same OPA checks.

## Connecting Google Drive or OneDrive (operational notes)

Both are **per-user OAuth**: an admin registers the provider app once, then each
person consents for themselves. An admin cannot connect Drive on someone's
behalf — the token is owner-scoped and owner-only, enforced in code.

**Register the app at Admin → Drive OAuth apps.** The redirect URI the OS sends
is `<public-url>/api/connections/oauth/<google|microsoft>/callback`, and it must
match byte for byte.

**Microsoft: the Azure app must be MULTI-TENANT.** The OS authenticates through
the `/common` endpoint. A single-tenant app there is rejected with
`AADSTS50194`, surfaced as a generic `invalid_request`. Set supported account
types to "any organizational directory", or `"signInAudience":
"AzureADMultipleOrgs"` in the manifest. Multi-tenant governs which directories
*could* authenticate; who actually gets in is still gated by consent.

**Scopes are read-only and minimal:** `drive.readonly` for Google;
`Files.Read` + `offline_access` for Microsoft. `offline_access` is what makes a
refresh token available, so without it a connection dies after an hour.

**If the exchange fails**, check the client **secret value**, not the secret ID —
Azure shows the value once and the ID looks plausible. The OS now forwards the
provider's code as `drive_detail`; `AADSTS7000215` means a bad secret.

**Known limits.** The connector reads the signed-in user's own drive. A Google
**Shared Drive** returns empty, because the Drive query does not send
`supportsAllDrives`/`includeItemsFromAllDrives`. A **SharePoint or Teams**
library is not reachable at all — the OneDrive connector calls `/me/drive`.
Folder scope needs a Graph **item id**, not a path, despite the field label.
