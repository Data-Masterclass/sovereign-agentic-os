# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""ML agent (LangGraph) — drives the traditional-ML flow from plain language:
build features (Featureform) -> train + track (MLflow) -> deploy (KServe).

This is the Layer-4 counterpart of the sample LangGraph agent. It exposes a tiny
HTTP surface the Science tab calls:

  GET  /health        -> liveness/readiness
  GET  /models        -> registered models from the MLflow registry
  POST /run           -> {"prompt": "..."} -> a planned ML flow (LLM via LiteLLM)

The LLM is reached only through the LiteLLM gateway with a scoped virtual key
(least privilege); every call is traced in Langfuse. Tool execution (Featureform
registration, MLflow training runs, KServe deploys) is intentionally thin here —
the production build wires these as MCP tools behind LiteLLM + OPA.
"""
import os
import json
from typing import TypedDict

import httpx
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from openai import OpenAI
from langgraph.graph import StateGraph, START, END

LITELLM_BASE_URL = os.environ.get("LITELLM_BASE_URL", "http://agentic-os-litellm:4000/v1")
LITELLM_API_KEY = os.environ.get("LITELLM_API_KEY", "sk-unused")
CHAT_MODEL = os.environ.get("CHAT_MODEL", "sovereign-mock")
MLFLOW_TRACKING_URI = os.environ.get("MLFLOW_TRACKING_URI", "http://mlflow:5000")
FEATUREFORM_HOST = os.environ.get("FEATUREFORM_HOST", "featureform:7878")
KSERVE_ENDPOINT = os.environ.get("KSERVE_ENDPOINT", "http://sample-sklearn-predictor:80")

client = OpenAI(base_url=LITELLM_BASE_URL, api_key=LITELLM_API_KEY)
app = FastAPI(title="ml-agent")


# --- LangGraph: a minimal plan(features -> train -> deploy) state machine -------
class FlowState(TypedDict):
    prompt: str
    plan: str


def _plan(state: FlowState) -> FlowState:
    """Ask the gateway-fronted LLM to turn the prompt into an ML plan."""
    resp = client.chat.completions.create(
        model=CHAT_MODEL,
        messages=[
            {
                "role": "system",
                "content": (
                    "You are the ML agent for a sovereign data platform. Turn the "
                    "user's request into a 3-step plan: (1) features in Featureform, "
                    "(2) train + log to MLflow, (3) deploy to KServe."
                ),
            },
            {"role": "user", "content": state["prompt"]},
        ],
    )
    return {"prompt": state["prompt"], "plan": resp.choices[0].message.content or ""}


_graph = StateGraph(FlowState)
_graph.add_node("plan", _plan)
_graph.add_edge(START, "plan")
_graph.add_edge("plan", END)
_flow = _graph.compile()


class RunRequest(BaseModel):
    prompt: str


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/models")
def models():
    """Registered models from the MLflow registry (best-effort)."""
    try:
        r = httpx.get(
            f"{MLFLOW_TRACKING_URI}/api/2.0/mlflow/registered-models/search",
            timeout=5,
        )
        return JSONResponse(r.json())
    except Exception as exc:  # noqa: BLE001 — surface a friendly error to the UI
        return JSONResponse({"registered_models": [], "error": str(exc)})


@app.post("/run")
def run(req: RunRequest):
    result = _flow.invoke({"prompt": req.prompt, "plan": ""})
    return {
        "plan": result["plan"],
        "targets": {
            "mlflow": MLFLOW_TRACKING_URI,
            "featureform": FEATUREFORM_HOST,
            "kserve": KSERVE_ENDPOINT,
        },
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))
