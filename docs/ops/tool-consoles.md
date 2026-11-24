# Tool consoles at `<domain>/tools/<tool>`

The OS can serve the admin consoles of the tools inside it — LiteLLM, Dagster, and later others —
on its own address, behind the OS sign-in. os-ui is a same-origin reverse proxy at
`<domain>/tools/<key>/`: it checks the OS session and role, signs into the tool server-side where
the tool has a login, and rewrites redirects and cookies into the prefix
(`os-ui/core/infra/tool-proxy.ts`).

## The defaults

| | |
|---|---|
| Every console | **OFF** after install. `/tools/<key>/…` and the short address answer **404**, for admins too. |
| Who may open a console that is ON | **Admins only.** Any other role gets 403 on `/tools/<key>/…` and 404 on the short address. |
| Signed out | A page load is sent to `/signin?next=…`; a script or API call gets 401. Nothing reaches the tool. |
| Switching | Platform → **Tool consoles** (admin only): one row per tool with the switch, its status, its address and what it shows. API: `GET` / `PATCH /api/platform-admin/tool-consoles` (`{ "key": "dagster", "exposed": true }`). |
| Audit | Every switch writes an audit row `tool-console.expose` with the actor, the tool, ON/OFF and the environment (the host of `OS_PUBLIC_URL`). If the row cannot be written the switch is put back. |
| Storage | `settings.toolConsoles.<key>.exposed` in the platform settings store (OpenSearch mirror `os-settings`); it survives a pod restart. The generic settings `PATCH` refuses this field, so it cannot change without its audit row. |

Status in the table:

- **available** — this install can serve it and the tool answered at its in-cluster address just now.
- **not set up on this install** — no address configured, or the tool did not answer.
- **not available yet** — serving it under `/tools` is not built (see "Pending" below). Its switch
  cannot be turned on.

## Short addresses

`/litellm`, `/dagster`, `/langfuse` and `/opensearch` answer **308 → `/tools/<key>/`** for an
admin while that console is ON and available; otherwise **404** (an unknown, off or pending tool
looks exactly like a page that does not exist). Signed out, they go to sign-in. `/trino` is not a
route yet (Trino is pending).

## What each console exposes

| Tool | Address | Shows | Notes |
|---|---|---|---|
| LiteLLM | `/tools/litellm/` (`/litellm`) | Every model, provider credential name, virtual key, budget and spend log. | Admin console with a server-minted UI session (`tool-sso-litellm.ts`); the master key never reaches the browser. The **public Model Hub** (`/tools/litellm/public/…`) is a product feature and stays open to every signed-in user whether the console is ON or OFF. |
| Dagster | `/tools/dagster/` (`/dagster`) | Every domain's assets, runs, schedules and run logs. | The **read-only** webserver (`dagster.dagsterWebserver.enableReadOnly`): no launches, schedule toggles or wipes from here. Dagster OSS has no login, so the OS sign-in plus the admin gate are the access control, and NetworkPolicy `dagster-webserver-read-only-ingress` admits only os-ui to that pod. |
| Langfuse | — | Users' prompts and answers, tool calls and results across every agent run. | Pending (below). |
| OpenSearch Dashboards | — | The raw search indexes, including file and knowledge content. | Pending (below). |
| MLflow, JupyterHub | `/tools/<key>/` | Experiments and models; notebook kernels. | Listed for completeness. JupyterHub needs WebSockets and stays pending. |

### Dagster behind the prefix

Both Dagster webservers run with `--path-prefix /tools/dagster`
(`dagster.dagsterWebserver.pathPrefix`), so the UI's scripts and GraphQL calls resolve under the
OS prefix. Consequences:

- Every in-cluster address of the editable webserver carries the prefix: os-ui's `DAGSTER_URL`
  (`osUI.dagsterUrl`), both `DAGSTER_GRAPHQL_URL`s of the code location and its repo-sync sidecar,
  and the generated overlays `values.dagster-launcher-lockdown.yaml` /
  `values.dagster-run-identity.yaml`. `scripts/check-dagster-path-prefix.mjs` (in
  `os-ui/scripts/gate.sh`) fails on any address without it, and on a prefix that differs from the
  os-ui registry's.
- The readiness probe is `/tools/dagster/server_info` (the subchart's default does not follow the prefix).
- os-ui reaches the read-only webserver at `DAGSTER_READONLY_URL`
  (`osUI.dagsterReadOnlyUrl`); it is empty when the read-only webserver does not render, and the
  console then reports "not set up".
- **WebSocket live updates do not pass the proxy.** Dagster pushes run progress over a GraphQL
  subscription (WebSocket); the `/tools` proxy is HTTP only. Pages render and are current on each
  load or navigation, but a run page does not tick live — reload it.
- The `dagster.<domain>` ingress (basic auth), where it is configured, now gets
  `app-root: /tools/dagster/`, so its root still lands on the UI.
- On the optional dev node m2i.4 the read-only webserver does not fit the capacity budget and is
  off (`values.dev.m2i4.yaml`): Dagster shows "not set up" there. The default dev node runs it.

## Demos: use dev

Demo the consoles on **dev** (`dev.<domain>`), which holds synthetic data only. Switch the console
on in Platform → Tool consoles before the demo and off afterwards; both are in the audit trail.
Do not switch consoles on in production for a demo: they show real users' data.

## Pending (owner decisions)

- **Langfuse under `/tools/langfuse`** — Langfuse is a Next.js app with root-absolute `/_next` and
  `/api` paths and no runtime base path in its official image, so it cannot render under the
  prefix. It keeps its own tab for now; the switch cannot be turned on.
- **Trino UI** — no console entry yet.
- **OpenSearch Dashboards** — waits on the decision about its security plugin and base path.

## Follow-ups

- **Remove the side doors after verification on dev.** The direct ingresses `dagster.<domain>`
  (production, basic auth only) and `langfuse.dev.<domain>` (dev, basic auth only) bypass the OS
  sign-in. Once `/tools/dagster` is verified on dev, remove `ingress.hosts.dagster` (and the Langfuse
  host on dev) so the consoles are reachable only through the OS. Not done in the change that
  introduced the switch, on purpose.
- Watch the Dagster webservers' memory on dev after the first apply (dev limit 448Mi each).
