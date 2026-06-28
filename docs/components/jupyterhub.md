# JupyterHub — multi-user notebooks (Science)

**What it is:** JupyterHub (Apache 2.0 / BSD-3, the Zero-to-JupyterHub chart) — per-domain
**multi-user notebooks** for traditional ML / data science, GPU-capable for training. The
Layer-4 **Science** entry point: explore data, build features (Featureform), train + log
models (MLflow), trigger deploys (KServe). **Off by default** (GPU-cost, opt-in; not in the
cohort-1 path).

## Enable it
Set `jupyterhub.enabled: true` and `helm upgrade`. Heavy — on a 14 GB kind VM enable it alone
(not alongside the full L1–L3 set) and spawn a single notebook. On STACKIT, give it a node
pool (optionally GPU) and turn on persistent storage + Ory auth.

## Access
```bash
kubectl -n agentic-os port-forward svc/proxy-public 8000:80
# open http://localhost:8000
```

## Login
Local uses the **DummyAuthenticator** — any username, password `jupyter-local-dev`
(`jupyterhub.hub.config.DummyAuthenticator.password`). **Production:** federate to **Ory**
via an OAuthenticator (no shared password) and enable per-user persistent home dirs.

## Usage
A spawned notebook (`quay.io/jupyter/scipy-notebook`, multi-arch) reaches the in-cluster
Science services: MLflow at `http://mlflow:5000`, Featureform at `featureform:7878`, the
LiteLLM gateway, and OpenSearch / the query tool. Set `MLFLOW_TRACKING_URI=http://mlflow:5000`
and `mlflow.autolog()` to track runs.

## FAQ
**Q: Why off by default?** Multi-user notebooks + a singleuser image per user are RAM/GPU
heavy and opt-in (`stack-decisions.md` / `build-layer4.md`).
**Q: GPU?** Add a GPU node pool + a `singleuser.profileList` GPU profile; the chart is
GPU-ready. CPU-only otherwise.
**Q: Where do models go?** Logged to MLflow (registry + the `mlflow` object-storage bucket),
then served by KServe.
