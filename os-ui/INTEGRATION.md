# OS UI — integration notes (for the chart/cluster owner)

The OS UI ships as **new files only**. To deploy it, the chart owner must add a few
entries to the **shared** files (this branch deliberately does **not** touch them to
avoid colliding with concurrent cluster work). Everything below is the exact diff to apply.

The UI itself lives in `os-ui/`; its image build is `images/os-ui/Dockerfile`; its
Deployment + Service is `charts/sovereign-agentic-os/templates/os-ui/os-ui.yaml`
(gated on `.Values.osUI.enabled`, so it renders to nothing until the values block exists).

---

## 1. `charts/sovereign-agentic-os/values.yaml`

Append this block (mirrors the `adminConsole:` block's shape). The template reads
`.Values.osUI.*` and the existing `.Values.langfuseInit.publicKey`.

```yaml
# -----------------------------------------------------------------------------
# OS UI — the Next.js front door. App shell + live surfaces:
#   Home (with a live stack-status strip), Agents/Chat, Knowledge (OpenSearch
#   search), Structured Data (query-tool + Iceberg table browser), Software
#   (Forgejo repos + CI runs), Monitoring (Langfuse), Governance (OPA grants
#   matrix), Dashboards (Superset link), and a Platform group: Gateway (LiteLLM
#   models + MCP tools), Orchestration (Dagster assets/runs), Consoles (launchpad
#   for the full external tool UIs).
# Server-side API routes call the in-cluster backends; all secret keys/passwords
# are read from existing Secrets so they never sit in plaintext. Non-root,
# port 3000, probes /api/health.
osUI:
  enabled: true
  image:
    repository: sovereign-os/os-ui    # built locally, loaded into kind
    tag: "0.1.0"
  # In-cluster backend Service URLs (base URLs; the app appends the paths).
  sampleAgentUrl: "http://sample-agent:8000"
  queryToolUrl:   "http://query-tool:8000"
  langfuseUrl:    "http://agentic-os-langfuse-web:3000"
  opensearchUrl:  "http://opensearch:9200"
  knowledgeIndex: "knowledge"
  forgejoUrl:     "http://forgejo-http:3000"
  forgejoUser:    "gitea_admin"
  litellmUrl:     "http://agentic-os-litellm:4000"
  opaUrl:         "http://opa:8181"
  dagsterUrl:     "http://agentic-os-dagster-webserver:80"
  # Browser-reachable consoles (linked/opened from the browser, never proxied;
  # each tool keeps its own auth). Defaults point at the local port-forwards from
  # docs/components/*.md; override per environment (e.g. an Ingress host) once
  # each console is exposed.
  supersetUrl:        "http://localhost:8088"
  langfuseConsoleUrl: "http://localhost:3000"
  forgejoConsoleUrl:  "http://localhost:3001"
  argocdUrl:          "http://localhost:8080"
  openmetadataUrl:    "http://localhost:8585"
  dagsterConsoleUrl:  "http://localhost:3070"
  # Secret-backed credentials — reuse the stack's existing Secrets so nothing
  # sensitive sits in plaintext (names/keys verified against the running cluster).
  langfuseSecret:
    name: langfuse-init
    key: LANGFUSE_INIT_PROJECT_SECRET_KEY
  forgejoSecret:
    name: forgejo-admin           # exists; keys: username, password
    key: password
  litellmSecret:
    name: litellm-credentials     # exists; keys incl. masterkey
    key: masterkey
  resources:
    requests: { cpu: 50m, memory: 128Mi }
    limits:   { cpu: 500m, memory: 512Mi }
```

> The public Langfuse key is taken from the existing `langfuseInit.publicKey`
> value (already present). No new Secrets are required — the UI reuses
> `langfuse-init`, `forgejo-admin`, and `litellm-credentials`. OpenSearch, OPA,
> query-tool and Dagster need no auth in-cluster (network default-deny guards them).

## 2. `scripts/build-images.sh`

The UI's build context is the **app dir** (`os-ui/`), referenced by `-f`, so it does
**not** fit the generic `images/<dir>` loop. Add it next to the `admin-console`
special case (which also uses a non-default context):

```bash
# OS UI needs the app dir (os-ui/) as the build context.
echo "==> building sovereign-os/os-ui:0.1.0 (context=os-ui/)"
docker build -q -t sovereign-os/os-ui:0.1.0 -f images/os-ui/Dockerfile os-ui >/dev/null
kind load docker-image sovereign-os/os-ui:0.1.0 --name "$CLUSTER" >/dev/null 2>&1 || true
```

## 3. `Chart.yaml`

**No change needed.** The OS UI is a bespoke in-chart template (like `admin-console`
and `sample-agent`), not a wrapped subchart — there is no `dependencies:` entry to add.
(Optionally bump the chart `version:` per your packaging policy when you cut a release.)

## 4. `README.md` (optional)

Add `os-ui` to the workloads list and a port-forward line:

```bash
kubectl -n agentic-os port-forward svc/os-ui 8080:3000   # OS UI front door
```

---

## Deploy + verify

```bash
./scripts/build-images.sh                       # builds + kind-loads sovereign-os/os-ui:0.1.0
helm upgrade agentic-os charts/sovereign-agentic-os -n agentic-os -f values.local.yaml
kubectl -n agentic-os rollout status deploy/os-ui
kubectl -n agentic-os port-forward svc/os-ui 8080:3000
# open http://localhost:8080 → Agents (ask a question), Structured Data (run SQL),
# Monitoring (recent traces). Dashboards links to Superset.
```

## Local dev / standalone (no cluster)

Point the env vars at port-forwards and run the image directly:

```bash
kubectl -n agentic-os port-forward svc/sample-agent 18001:8000 &
kubectl -n agentic-os port-forward svc/query-tool   18000:8000 &
kubectl -n agentic-os port-forward svc/agentic-os-langfuse-web 13000:3000 &
kubectl -n agentic-os port-forward svc/opensearch   19200:9200 &
kubectl -n agentic-os port-forward svc/forgejo-http 19300:3000 &
kubectl -n agentic-os port-forward svc/agentic-os-litellm 14000:4000 &
kubectl -n agentic-os port-forward svc/opa          18181:8181 &
kubectl -n agentic-os port-forward svc/agentic-os-dagster-webserver 13070:80 &

docker run --rm -p 18080:3000 \
  -e SAMPLE_AGENT_URL=http://host.docker.internal:18001 \
  -e QUERY_TOOL_URL=http://host.docker.internal:18000 \
  -e LANGFUSE_URL=http://host.docker.internal:13000 \
  -e LANGFUSE_PUBLIC_KEY=pk-lf-localdev0000public \
  -e LANGFUSE_SECRET_KEY=sk-lf-localdev0000secret \
  -e OPENSEARCH_URL=http://host.docker.internal:19200 \
  -e FORGEJO_URL=http://host.docker.internal:19300 \
  -e LITELLM_URL=http://host.docker.internal:14000 \
  -e OPA_URL=http://host.docker.internal:18181 \
  -e DAGSTER_URL=http://host.docker.internal:13070 \
  sovereign-os/os-ui:0.1.0
# → http://localhost:18080
# (Forgejo/LiteLLM creds default to the dev values; override with FORGEJO_PASSWORD /
#  LITELLM_MASTER_KEY if yours differ. Console URLs default to localhost port-forwards.)
```

## Environment variables (all optional; defaults = in-cluster Service names)

| Var | Default | Used by |
|---|---|---|
| `SAMPLE_AGENT_URL` | `http://sample-agent:8000` | Agents/Chat → `GET /ask?q=` |
| `QUERY_TOOL_URL` | `http://query-tool:8000` | Structured Data + Lakehouse → `POST /query` |
| `LANGFUSE_URL` | `http://agentic-os-langfuse-web:3000` | Monitoring → `GET /api/public/traces` |
| `LANGFUSE_PUBLIC_KEY` | `pk-lf-localdev0000public` | Langfuse basic-auth user |
| `LANGFUSE_SECRET_KEY` | `sk-lf-localdev0000secret` | Langfuse basic-auth password (Secret in-cluster) |
| `OPENSEARCH_URL` | `http://opensearch:9200` | Knowledge → `POST /{index}/_search` |
| `KNOWLEDGE_INDEX` | `knowledge` | Knowledge index name |
| `FORGEJO_URL` | `http://forgejo-http:3000` | Software → `GET /api/v1/...` |
| `FORGEJO_USER` | `gitea_admin` | Forgejo basic-auth user |
| `FORGEJO_PASSWORD` | `forgejo-admin-local-dev` | Forgejo basic-auth password (Secret `forgejo-admin`/`password`) |
| `LITELLM_URL` | `http://agentic-os-litellm:4000` | Gateway → `GET /v1/models` + `/v1/mcp/tools` |
| `LITELLM_MASTER_KEY` | `sk-litellm-local-dev-master` | LiteLLM bearer (Secret `litellm-credentials`/`masterkey`) |
| `OPA_URL` | `http://opa:8181` | Governance → grants + `authz/allow` |
| `DAGSTER_URL` | `http://agentic-os-dagster-webserver:80` | Orchestration → GraphQL |
| `SUPERSET_URL` | `http://localhost:8088` | Dashboards link / Consoles |
| `LANGFUSE_CONSOLE_URL` | `http://localhost:3000` | Consoles launchpad |
| `FORGEJO_CONSOLE_URL` | `http://localhost:3001` | Software + Consoles links |
| `ARGOCD_URL` | `http://localhost:8080` | Software + Consoles links |
| `OPENMETADATA_URL` | `http://localhost:8585` | Consoles launchpad |
| `DAGSTER_CONSOLE_URL` | `http://localhost:3070` | Orchestration + Consoles links |

> **Secrets:** the Deployment wires `LANGFUSE_SECRET_KEY`, `FORGEJO_PASSWORD`, and
> `LITELLM_MASTER_KEY` from `secretKeyRef` (`langfuse-init`, `forgejo-admin`,
> `litellm-credentials`). The browser never receives any of these — all backend calls
> go through the server-side API routes.
