#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""
Poet agent — writes a short poem to a file every time it runs.

A second sample LangGraph agent (compose -> save): it asks the model (via the
LiteLLM gateway) for a short poem about a topic, then writes it to a Markdown
file on a persistent volume. Each run drops a new file you can open. The model
call is traced in Langfuse (agent span via @observe + the gateway trace).

Plain stdlib HTTP server. Trigger a poem:  GET /write?topic=the%20sea
"""
import json
import os
import re
import time
import traceback
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

LITELLM_BASE = os.environ.get("LITELLM_BASE_URL", "http://agentic-os-litellm:4000/v1")
LITELLM_KEY = os.environ.get("LITELLM_API_KEY", "")
CHAT_MODEL = os.environ.get("CHAT_MODEL", "sovereign-mock")
POEMS_DIR = os.environ.get("POEMS_DIR", "/data/poems")
DEFAULT_TOPIC = os.environ.get("DEFAULT_TOPIC", "the sovereign cloud")
PORT = int(os.environ.get("PORT", "8000"))

LANGFUSE_ENABLED = False
try:
    from langfuse.openai import OpenAI
    from langfuse import observe, get_client
    LANGFUSE_ENABLED = True
    print("[poet] Langfuse tracing enabled")
except Exception as e:  # pragma: no cover
    from openai import OpenAI
    print(f"[poet] Langfuse SDK unavailable ({e}); LiteLLM still traces the gateway")

    def observe(*a, **k):
        def deco(fn):
            return fn
        return deco

client = OpenAI(base_url=LITELLM_BASE, api_key=LITELLM_KEY)


def _slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:40] or "poem"


# ---- LangGraph: compose -> save -------------------------------------------
from typing import TypedDict  # noqa: E402
from langgraph.graph import START, END, StateGraph  # noqa: E402


class State(TypedDict):
    topic: str
    poem: str
    path: str


def node_compose(state: State):
    resp = client.chat.completions.create(
        model=CHAT_MODEL,
        messages=[
            {"role": "system", "content": "You are a poet. Write a short, 4-line poem."},
            {"role": "user", "content": f"Write a short poem about {state['topic']}."},
        ],
    )
    return {"poem": resp.choices[0].message.content.strip()}


def node_save(state: State):
    os.makedirs(POEMS_DIR, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    path = os.path.join(POEMS_DIR, f"poem-{stamp}-{_slug(state['topic'])}.md")
    iso = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    with open(path, "w") as f:
        f.write(
            f"# A poem about {state['topic']}\n\n"
            f"{state['poem']}\n\n"
            f"---\n"
            f"_written by the Sovereign Agentic OS poet agent_  \n"
            f"_model: {CHAT_MODEL} (via LiteLLM) · traced in Langfuse · {iso}_\n"
        )
    return {"path": path}


_g = StateGraph(State)
_g.add_node("compose", node_compose)
_g.add_node("save", node_save)
_g.add_edge(START, "compose")
_g.add_edge("compose", "save")
_g.add_edge("save", END)
GRAPH = _g.compile()


@observe(name="poet-agent")
def write_poem(topic: str):
    result = GRAPH.invoke({"topic": topic, "poem": "", "path": ""})
    if LANGFUSE_ENABLED:
        try:
            get_client().update_current_trace(
                input=topic, output=result["poem"], tags=["agent-core", "poet"]
            )
            get_client().flush()
        except Exception:
            pass
    return result


# ---- HTTP API --------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print("[poet] " + (fmt % args))

    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _list(self):
        try:
            return sorted(f for f in os.listdir(POEMS_DIR) if f.endswith(".md"))
        except FileNotFoundError:
            return []

    def do_GET(self):
        u = urlparse(self.path)
        if u.path in ("/health", "/healthz", "/"):
            return self._send(200, {"status": "ok", "langfuse": LANGFUSE_ENABLED,
                                    "poems": len(self._list())})
        if u.path == "/list":
            return self._send(200, {"poems": self._list()})
        if u.path == "/write":
            topic = (parse_qs(u.query).get("topic") or [DEFAULT_TOPIC])[0]
            return self._write(topic)
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        u = urlparse(self.path)
        if u.path == "/write":
            length = int(self.headers.get("Content-Length", "0") or "0")
            req = json.loads(self.rfile.read(length) or b"{}")
            return self._write(req.get("topic", DEFAULT_TOPIC))
        return self._send(404, {"error": "not found"})

    def _write(self, topic):
        try:
            result = write_poem(topic)
            return self._send(200, {
                "topic": topic,
                "poem": result["poem"],
                "file": result["path"],
                "traced_in_langfuse": LANGFUSE_ENABLED,
            })
        except Exception as e:
            traceback.print_exc()
            return self._send(500, {"error": str(e)})


def wait_for_gateway():
    for _ in range(60):
        try:
            client.chat.completions.create(
                model=CHAT_MODEL,
                messages=[{"role": "user", "content": "warmup"}],
            )
            return True
        except Exception:
            time.sleep(3)
    return False


def main():
    print(f"[poet] starting on :{PORT} (model={CHAT_MODEL}, dir={POEMS_DIR})")
    if wait_for_gateway():
        try:
            r = write_poem(DEFAULT_TOPIC)   # one poem on startup
            print(f"[poet] startup poem written: {r['path']}")
        except Exception as e:
            print(f"[poet] startup poem failed: {e}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
