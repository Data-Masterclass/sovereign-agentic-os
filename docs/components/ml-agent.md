# ML agent — LangGraph ML pipeline driver (Science)

**What it is:** the **ML agent** (LangGraph, MIT library) — drives the traditional-ML flow from
plain language: **build features** (Featureform) → **train + track** (MLflow) → **deploy**
(KServe). It's the Layer-4 counterpart of the sample agent and the brain behind the **Science**
tab. **Off by default** (opt-in Science component).

It calls the LLM only through the **LiteLLM** gateway with a scoped virtual key (least
privilege) and is traced in **Langfuse** — same secure pattern as the other agents.

## Enable it
Set `mlAgent.enabled: true` and `helm upgrade` (build/load `sovereign-os/ml-agent` first). It's
most useful with `mlflow.enabled: true` (and `featureform` / `kserve` as needed).

## Access
```bash
kubectl -n agentic-os port-forward svc/ml-agent 8000:8000
curl localhost:8000/health
curl localhost:8000/models                     # registered models from MLflow
curl -X POST localhost:8000/run -H 'content-type: application/json' \
  -d '{"prompt":"predict churn from the orders table"}'
```

## Login
No auth on the service (in-cluster only; default-deny network). The LLM call is authorized by
the scoped LiteLLM key in `agent-litellm-key`.

## Usage
`POST /run` returns a planned features→train→deploy flow (LLM via LiteLLM). The Science tab
calls `/run` to kick off a pipeline and `/models` to list registry models. **Production wiring
(integration step):** expose its tools (`feature_build`, `model_train`, `model_deploy`) via the
**LiteLLM MCP gateway** and grant them in **OPA** for the agent's key — see
`CI-LAYER4-INTEGRATION.md`.

## FAQ
**Q: Is this LLM serving?** No — it's an *agent* that orchestrates *traditional* ML. The models
it trains/serves (sklearn etc.) are not LLMs.
**Q: arm64?** Yes — `python:3.12-slim` base, builds natively on Apple Silicon.
