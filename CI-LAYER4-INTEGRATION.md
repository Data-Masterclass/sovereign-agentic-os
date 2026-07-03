# Layer 4 (Science / ML) — integration & deploy notes

Hand-off for the integrator (Alex). This branch adds **Layer 4 (Science / ML)** to the umbrella
chart — **chart artifacts only**. Nothing was deployed; `os-ui/`, `README.md`,
`install.sh`, the profile values files, `scripts/`, and `.github/` were **not touched**. The
Science layer is **traditional ML, not LLM serving**, and ships **OFF by default everywhere**
(a GPU-cost, opt-in capability; not in the cohort-1 path — per `build-layer4.md` /
`stack-decisions.md`).

Worktree branch: **`worktree-agent-a83b79df089d15f21`**

---

## What was added

| Component | Version | Subchart / bespoke | Image | arm64 |
|---|---|---|---|---|
| **JupyterHub** (Apache 2.0 / BSD-3) | chart `4.4.0` (app 5.5.0) | **Subchart** (Zero-to-JupyterHub, `condition: jupyterhub.enabled`) | hub `quay.io/jupyterhub/k8s-hub:4.4.0`; singleuser `quay.io/jupyter/scipy-notebook:2024-10-14` | ✅ both multi-arch (verified) |
| **MLflow** (Apache 2.0) | image `2.19.0` | **Bespoke** (`templates/science/mlflow.yaml`) | `sovereign-os/mlflow` (custom: mlflow + psycopg2 + boto3; `images/mlflow/`) | ✅ `python:3.12-slim` base is multi-arch |
| **Featureform** (MPL-2.0) | image `0.15.10` | **Bespoke** (`templates/science/featureform.yaml`) | `featureformcom/featureform:0.15.10` | ✅ multi-arch (verified — **no custom build needed**) |
| **KServe** (Apache 2.0) | controller bootstrap (RawDeployment) | **Bespoke CR** (`templates/science/kserve.yaml` — sample `InferenceService`) | upstream KServe controller + sklearn runtime (multi-arch) | ✅ CR is arch-neutral |
| **ML agent** (LangGraph, MIT) | image `0.1.0` | **Bespoke** (`templates/science/ml-agent.yaml`) | `sovereign-os/ml-agent` (custom; `images/ml-agent/`) | ✅ `python:3.12-slim` base is multi-arch |

**Apache Spark** (optional distributed training, off by default) is already present as a stub
(`spark.enabled: false`) — left as-is; out of scope for this layer per "favor correct over
breadth".

### Files
- `charts/sovereign-agentic-os/Chart.yaml` — added the `jupyterhub` dependency (lock regenerated via `helm dependency update`).
- `charts/sovereign-agentic-os/values.yaml` — appended the **Layer 4 (Science / ML)** section (`jupyterhub`, `mlflow`, `featureform`, `kserve`, `mlAgent`, all `enabled: false`); additively added `mlflow` to `objectStorage.buckets` and an `mlflow` entry to `postgres.extraDatabases`.
- `charts/sovereign-agentic-os/templates/science/{mlflow,featureform,kserve,ml-agent}.yaml`
- `images/mlflow/`, `images/ml-agent/`
- `docs/components/{jupyterhub,mlflow,featureform,kserve,ml-agent}.md`

---

## Values keys (all default `enabled: false`)

`jupyterhub.*` · `mlflow.*` · `featureform.*` · `kserve.*` · `mlAgent.*`

Backing services reuse the stack (no new infra): Postgres = CNPG **`mlflow`** extraDatabase
(secret `postgres-mlflow-credentials`); artifacts = object-storage **`mlflow`** bucket;
Featureform online store = **Valkey** (`valkey-credentials`); ML agent LLM = **LiteLLM** scoped
key (`agent-litellm-key`).

### RAM budget — what to keep OFF on a 14 GB kind node
The full L1–L3 self-contained slice already nearly fills a 14 GB VM. The Science layer is
**additive and heavy**, so do **not** run it alongside the full slice. On 14 GB:
- **OK (one at a time):** `mlflow` (~0.5–1 GB) **or** a single JupyterHub notebook
  (hub ~0.4 GB + one singleuser pod ~0.5–2 GB).
- **Keep OFF on 14 GB:** `featureform` (~1 GB + the providers it talks to), `kserve` (needs the
  controller + cert-manager + a model-server pod), running `jupyterhub` **and** `mlflow`
  **and** the full L1–L3 set together. To exercise the whole Science flow, scale the node
  (≥ 24–32 GB) or use the STACKIT node.
- Recommended local smoke test: turn the heavy L2 bits off (they already are in
  `values.selfcontained.yaml`: docling/osdashboards/openmetadata) and enable **just** `mlflow`
  + one notebook.

> Note: I did **not** edit `values.selfcontained.yaml` / `values.local.yaml` (owned by you).
> Because the Science product default is already `enabled: false`, no override is needed there
> to keep them off locally — enable per component when you want them.

---

## What you must do to deploy + validate on the cluster

Done already (chart-level, no cluster writes):
- `helm dependency update charts/sovereign-agentic-os` → resolves; `jupyterhub-4.4.0.tgz` pulled, `Chart.lock` regenerated.
- `helm lint charts/sovereign-agentic-os -f values.selfcontained.yaml` → passes (0 failed).
- `helm template … --set <each>.enabled=true --show-only templates/science/<c>.yaml | kubectl apply --dry-run=client` → mlflow/featureform/ml-agent render & dry-run **clean**. JupyterHub subchart renders (251 objects, exit 0). KServe `InferenceService` renders as valid YAML but the **client dry-run needs the KServe CRDs installed** (see below) — same as CNPG CRDs being a prerequisite.

### 1. Build + load the custom images (into kind)
```bash
docker build -t sovereign-os/mlflow:2.19.0   images/mlflow
docker build -t sovereign-os/ml-agent:0.1.0  images/ml-agent
kind load docker-image sovereign-os/mlflow:2.19.0 sovereign-os/ml-agent:0.1.0 --name agentic-os
```
(Or fold into the repo's existing image build/load step — I didn't touch `Makefile`/`scripts/`.)

### 2. KServe controller — bootstrap BEFORE enabling `kserve` (parallels the CNPG operator)
```bash
helm install cert-manager jetstack/cert-manager -n cert-manager --create-namespace --set crds.enabled=true
helm install kserve oci://ghcr.io/kserve/charts/kserve -n kserve --create-namespace \
  --set kserve.controller.deploymentMode=RawDeployment
```
RawDeployment mode = no Knative/Istio. Without this, the `InferenceService` CR has no CRD to map
to (the only item that doesn't pass the offline dry-run today).

### 3. Enable + upgrade (pick per RAM budget)
```bash
helm upgrade agentic-os charts/sovereign-agentic-os -n agentic-os \
  -f values.selfcontained.yaml \
  --set mlflow.enabled=true            # add jupyterhub/featureform/kserve/mlAgent as the node allows
```
Enabling `mlflow` auto-provisions the CNPG `mlflow` DB + the `mlflow` bucket (the existing
postgres/object-storage bootstrap iterates the lists I appended to).

### 4. Prove the flow (per build-layer4.md gate)
- JupyterHub: `kubectl -n agentic-os port-forward svc/proxy-public 8000:80` → login (dummy, pw `jupyter-local-dev`).
- MLflow: from a notebook, `mlflow.set_tracking_uri("http://mlflow:5000")`, train a small sklearn model, `log_model(..., registered_model_name="sample-sklearn")`. UI: `port-forward svc/mlflow 5000:5000`.
- Featureform: register a Valkey online + Iceberg offline provider, then a feature.
- KServe: point `kserve.sampleModel.storageUri` at the logged artifact (`s3://mlflow/...`), enable `kserve`, `curl …/v1/models/sample-sklearn:predict`.
- ML agent: `port-forward svc/ml-agent 8000:8000`; `POST /run {"prompt":"…"}` returns a planned features→train→deploy flow (LLM via LiteLLM, traced in Langfuse); `GET /models` lists the registry.

### 5. Production wiring follow-ups (deliberately left as integration steps, to stay isolated)
- **MCP + OPA for the ML agent:** add `ml-agent`'s tools to `litellm.proxy_config.mcp_servers`
  and a `sovereign-ml-agent` principal under `opa.grants` (both are existing sections I avoided
  editing). Grant `feature_build`, `model_train`, `model_deploy`; deny internet.
- **JupyterHub auth → Ory:** swap `DummyAuthenticator` for an OAuthenticator against Ory; add
  per-user persistent home PVCs; add a GPU `profileList` if a GPU pool exists.
- **MLflow:** front with auth (Ory / proxy) before exposing beyond the cluster.

---

## What the OS UI **Science** tab should point at (service names / ports, namespace `agentic-os`)

| Purpose | In-cluster URL | Notes |
|---|---|---|
| Notebooks (launch) | `http://proxy-public:80` (JupyterHub) | spawn/list user servers |
| Experiments + model registry / metrics | `http://mlflow:5000` | REST API `…/api/2.0/mlflow/*`; UI for humans |
| Features (list/create) | `featureform:7878` (API/gRPC), dashboard `http://featureform:80` | online store = Valkey |
| Deployed inference endpoints | `http://sample-sklearn-predictor:80` (per-model, `<isvc>-predictor`) | from KServe RawDeployment |
| ML agent (trigger flow / list models) | `http://ml-agent:8000` | `GET /health`, `GET /models`, `POST /run` |

Artifact types for the tab: **features** (Featureform) and **ML models** (MLflow registry +
KServe endpoints). Role-gating per `os-application.md`: Creators build, Builders certify +
approve go-live, Users consume deployed models. (The tab itself + `os-ui` wiring are yours.)

---

## Gaps / caveats
- **KServe = bootstrap, not bundled.** The chart ships only the `InferenceService` CR; the
  controller + cert-manager must be installed first (documented above). This is the only Science
  object that doesn't pass an offline `kubectl apply --dry-run=client` until its CRDs exist —
  identical to how CNPG CRDs are a prerequisite for the existing `Cluster`/`Database` CRs.
- **No amd64-only blockers.** Unlike Dagster (which needed a custom arm64 image), **all** Layer-4
  images are multi-arch or built from a multi-arch base — including Featureform (`0.15.10`,
  verified). No custom arm64 build is required.
- **Custom images not built here** (chart-level task only): `sovereign-os/mlflow:2.19.0` and
  `sovereign-os/ml-agent:0.1.0` — build/load per step 1.
- **MLflow auth:** none locally (in-cluster, default-deny network) — add an auth proxy for prod.
- **JupyterHub `secretToken` / DummyAuthenticator password** in `values.yaml` are clearly-marked
  local dev throwaways; replace with external secrets + Ory on STACKIT.
