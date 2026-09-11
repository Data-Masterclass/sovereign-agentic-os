# Sovereign Agentic OS - Docker Compose

A local Docker Compose stack that runs the Agents golden path - LiteLLM,
Forgejo, OPA, a real agent runtime, Langfuse, and the OS UI - from one
`compose.yaml` at the repo root.

It runs fully offline by default: `mock-model` serves chat completions and
embeddings, so no Kubernetes cluster and no model API key are needed.

| Group | Service | Role | Runs |
|---|---|---|---|
| Application | `os-ui` | Front door | Always |
| Application | `agent-runtime` | Executes agent systems | Always |
| Application | `litellm` | Model / MCP gateway | `litellm-local` |
| Application | `mock-model` | Chat + embeddings stub | Always |
| Application | `opa` | Policy gate | Always |
| Application | `forgejo-http` | Git server | Always |
| Application | `langfuse-web` | Trace UI + API | `langfuse-local` |
| Application | `langfuse-worker` | Trace processing | `langfuse-local` |
| Infrastructure | `pg-rw` | Postgres | `postgres-local`, `litellm-local`, `langfuse-local` |
| Infrastructure | `clickhouse` | Langfuse's analytics store | `langfuse-local` |
| Infrastructure | `valkey` | Langfuse's job queue | `langfuse-local` |
| Infrastructure | `minio` | Langfuse's blob store | `langfuse-local` |
| One-shot | `forgejo-init` | Creates the Forgejo admin user | Always |
| One-shot | `litellm-key-init` | Creates the agent's LiteLLM key | `litellm-local` |
| One-shot | `minio-bucket-init` | Creates the Langfuse bucket | `langfuse-local` |

## Quick start

```
cp .env.example .env
docker compose up
```

1. Wait for `docker compose ps` to show every service healthy.
2. Open **http://localhost:3000**.
3. Log in as **admin** / **admin**.
4. Go to the **Agents** tab. Click **SimpleBuilder**. Create a system. Click **Build**.
5. Click **Run**.
6. Open the **Monitoring** tab, or **http://localhost:3002**.

## The three URLs

| Service | URL | Login |
|---|---|---|
| OS UI | http://localhost:3000 | `admin` / `admin` |
| Forgejo | http://localhost:3001 | `gitea_admin` / `forgejo-admin-local-dev` |
| Langfuse | http://localhost:3002 | `alex@datamasterclass.com` / `langfuse-local-dev-admin` |

These logins are created automatically: `OS_USERS` seeds os-ui, `forgejo-init`
seeds Forgejo, and `LANGFUSE_INIT_*` seeds Langfuse.

## How this is organized

A Compose profile decides which local containers start. An environment
variable decides what an application connects to. These are independent:
turning off a profile stops the local container, but you still have to set
the matching env var yourself - see How to run externally.

For example, `OS_UI_LITELLM_URL` defaults to the local `litellm` container
whether or not `litellm-local` is active.

| Setting | Controls |
|---|---|
| Compose profile | Which local containers start (`postgres-local`, `litellm-local`, `langfuse-local`), set via `COMPOSE_PROFILES` in `.env`. |
| Env var | What an app connects to (e.g. `OS_UI_LITELLM_URL`, `LITELLM_LANGFUSE_HOST`), each `${VAR:-default}` in `compose.yaml`. |

## How to run externally

Point at infrastructure you've deployed elsewhere instead of running it
locally. Pick a mode, copy its block into `.env`, and fill in your values.

| Mode | LiteLLM | Langfuse |
|---|---|---|
| Deployed LiteLLM | deployed | local |
| Deployed Langfuse | local | deployed |

To use both deployed, combine the two blocks below.

### The two LiteLLM keys

| Key | Used by | What it is |
|---|---|---|
| `PROXY_MASTER_KEY` | os-ui | Full admin key (see Local LiteLLM admin UI). |
| `LITELLM_AGENT_KEY` | agent-runtime | Limited key, scoped to the app's own models. |

The local stack creates `LITELLM_AGENT_KEY` automatically (`litellm-key-init`).
In external mode, create it yourself: open the deployed instance's LiteLLM
dashboard, go to Virtual Keys, create a key, and put its value in
`LITELLM_AGENT_KEY`.

### Use a deployed LiteLLM

LiteLLM runs on your deployed instance. Postgres and Langfuse stay local.

```
COMPOSE_PROFILES=postgres-local,langfuse-local                 # drop litellm-local
PROXY_MASTER_KEY=<the deployed instance's real master key>     # os-ui's admin key
LITELLM_AGENT_KEY=sk-agents-local-dev                           # must match the key you create above
OS_UI_LITELLM_URL=https://litellm.example.com                   # os-ui -> LiteLLM
AGENT_RUNTIME_LITELLM_BASE_URL=https://litellm.example.com/v1    # agent-runtime -> LiteLLM
# Set these only if the deployed instance does not serve the sovereign-* aliases.
# Use the model names it does serve - check with: GET /v1/models
LITELLM_CHAT_MODEL=<a model your instance serves>
LITELLM_REASONING_MODEL=<a model your instance serves>
LITELLM_EXEC_MODEL=<a model your instance serves>
AGENT_RUNTIME_CHAT_MODEL=<a model your instance serves>
AGENT_RUNTIME_REASONING_MODEL=<a model your instance serves>
AGENT_RUNTIME_EXECUTION_MODEL=<a model your instance serves>
```

### Use a deployed Langfuse

Langfuse runs on your deployed instance. LiteLLM (with mock-model) stays local.

```
COMPOSE_PROFILES=postgres-local,litellm-local                 # drop langfuse-local
OS_UI_LANGFUSE_URL=https://langfuse.example.com                # os-ui -> Langfuse
LITELLM_LANGFUSE_HOST=https://langfuse.example.com             # LiteLLM's trace callback -> Langfuse
LANGFUSE_INIT_PROJECT_PUBLIC_KEY=pk-...   # the deployed project's real key pair
LANGFUSE_INIT_PROJECT_SECRET_KEY=sk-...   # same project, secret half
```

The deployed instance must be Langfuse v3. os-ui's client uses hardcoded v3
API paths. On v4 with `LANGFUSE_MIGRATION_V4_WRITE_MODE=events_only`, the
ingestion endpoint rejects `trace-create` events, and the trace-read
endpoints 404.

Tracing: local LiteLLM writes full prompt and completion detail to Langfuse.
An external LiteLLM writes those traces to its own Langfuse instead - your
local Langfuse then shows only os-ui's agent spans (`agent.generate`,
`agent.search_knowledge`), not the model prompt or completion.

### Use a real model through the local LiteLLM

Keeps LiteLLM local but points it at a real provider, so you get real model
answers and still get full trace detail in the local Langfuse. This is the
same arrangement the deployed Helm environment uses.

In `compose/litellm/config.yaml`, the three chat aliases (`sovereign-default`,
`sovereign-mock`, `sovereign-reasoning`) each have a commented real-provider
block - replace the active values with those, filling in the provider's URL
and model names. In `.env`, uncomment `STACKIT_API_KEY` and set it to the
provider's key. Nothing else changes: `COMPOSE_PROFILES` stays as it is, and
the six model-name variables above don't need overriding, because the alias
names stay `sovereign-*` and the local LiteLLM handles the translation.

The stack is no longer offline in this mode. The committed default routes to
`mock-model`, so the offline path keeps working.

## Testing the flow

1. `docker compose ps` - every service should show `healthy`.
2. Open http://localhost:3000, log in as `admin` / `admin`, and walk the
   golden path: Agents → SimpleBuilder → create a system → Build → Run.
3. Build's response should include `mode: "live"`.
4. Open http://localhost:3001 and confirm a new repository exists under
   `gitea_admin`.
5. Open http://localhost:3002 (or the Monitoring tab) and confirm a trace
   exists for that Run.

## Switching modes

- Run `docker compose down` before you change `COMPOSE_PROFILES`, or the old
  containers keep running alongside the new ones.
- Run `docker compose up -d --force-recreate os-ui` after any env var change
  that affects it - a plain `up` doesn't always restart it.
- Check the change took effect:
  `docker compose exec os-ui env | grep -iE 'LANGFUSE_URL|LITELLM_URL|MODEL'`.

## Limitations

- Postgres's init script (`compose/postgres/init/10-extra-databases.sh`)
  only runs on a fresh volume, the first time `pg-rw` boots. Changing a
  Postgres credential afterward doesn't change what's already in the
  database - see Teardown to start over.
- An external Langfuse must be v3. v4 is not supported (see How to run externally).
- Using a deployed LiteLLM reduces local trace detail (see How to run
  externally).
- `mock-model` always answers with the same deterministic stub. To use a
  real model, see Use a real model through the local LiteLLM.
- The Helm chart deploys 47 workloads. This stack covers 17 of them - the 15
  services listed at the top, since LiteLLM and Forgejo each account for two
  chart workloads. 30 are not included.
- The 30 fall into three groups: services outside the Phase 2.1 scope (the
  data and knowledge layers), Kubernetes-only services with no Compose
  equivalent such as ArgoCD, and services already switched off in the
  chart's own local configuration.
- Knowledge, Files, Data, Metrics, Dashboards, Software, Components, and
  Console show empty or unavailable.
- The "LIVE CLUSTER" indicator in the header is meaningless here - there's
  no Kubernetes API in Compose.

## Local LiteLLM admin UI

Open http://localhost:4000 when `litellm-local` is active. Log in with
username `admin` and the value of `PROXY_MASTER_KEY` as the password.

## Teardown

- `docker compose down` stops everything and keeps your data.
- `docker compose down -v` also deletes the named volumes (`pg-data`,
  `forgejo-data`, `clickhouse-data`, `minio-data`).

## Adding more services

This stack is intentionally scoped to the Agents flow. Further services can
be added incrementally as development needs them: a new service block in
`compose.yaml`, with a `profiles:` entry if it should be optional.

Some chart workloads have no Compose equivalent at all, because they depend
on the Kubernetes API. Not every remaining service will be added.
