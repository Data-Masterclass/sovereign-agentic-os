#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""
MCP test agent — proves the OS's real, governed MCP registry works end to end,
the same way `sample-agent` proves OpenSearch+RAG works end to end.

Flow:
  1. Ask the OS's own remote MCP endpoint (`/api/mcp`) what tools are available,
     as a designated demo user (a bearer token, minted once via the normal
     "copy my MCP token" UI flow — NOT a fake/service identity).
  2. Give that tool list + a system prompt to the model (via LiteLLM). The model
     decides whether a tool is needed.
  3. If it calls one, the request goes back through the SAME real `/api/mcp`
     endpoint — so OPA/role/DLS governance applies exactly as it would for a
     human using Claude Desktop. No privileged path, no bypass.
  4. Trace the whole run in Langfuse.

This is deliberately generic: it never hardcodes which tool exists. Whatever the
demo user's role is authorized to see is what the agent gets — proven by asking
the real registry at run time, not by assuming a fixed list.
"""
import json
import os
import sys
import time
import traceback
import uuid
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

import requests

# ---- config (from env / ConfigMap / Secret) --------------------------------
MCP_URL = os.environ.get("MCP_URL", "http://os-ui:3000/api/mcp")
MCP_TOKEN = os.environ.get("MCP_TOKEN", "")  # the demo user's minted MCP bearer
LITELLM_BASE = os.environ.get("LITELLM_BASE_URL", "http://agentic-os-litellm:4000/v1")
LITELLM_KEY = os.environ.get("LITELLM_API_KEY", "")
CHAT_MODEL = os.environ.get("CHAT_MODEL", "sovereign-mock")
PORT = int(os.environ.get("PORT", "8000"))

# ---- Langfuse-traced OpenAI client (graceful fallback) ---------------------
LANGFUSE_ENABLED = False
try:
    from langfuse.openai import OpenAI  # auto-traces chat calls to Langfuse
    from langfuse import observe, get_client
    LANGFUSE_ENABLED = True
    print("[mcp-test-agent] Langfuse tracing enabled (langfuse.openai)")
except Exception as e:  # pragma: no cover - fallback path
    from openai import OpenAI
    print(f"[mcp-test-agent] Langfuse SDK unavailable ({e}); LiteLLM still traces the gateway")

    def observe(*dargs, **dkwargs):
        def deco(fn):
            return fn
        return deco

client = OpenAI(base_url=LITELLM_BASE, api_key=LITELLM_KEY)

SYSTEM_PROMPT = (
    "You are the Sovereign Agentic OS assistant. You may have real tools available, "
    "fetched live from the OS's own governed tool registry for this account — never "
    "assume a tool exists beyond what you were given. If a tool call is denied or "
    "errors, say so honestly; never invent a result. If no tool is needed, answer "
    "directly."
)


# ---- MCP JSON-RPC client (talks to the OS's own /api/mcp) ------------------
class McpError(Exception):
    pass


def mcp_call(method: str, params: dict | None = None):
    body = {"jsonrpc": "2.0", "id": str(uuid.uuid4()), "method": method}
    if params is not None:
        body["params"] = params
    resp = requests.post(
        MCP_URL,
        json=body,
        headers={"Authorization": f"Bearer {MCP_TOKEN}", "Content-Type": "application/json"},
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    if "error" in data:
        raise McpError(f"{method}: {data['error'].get('message', data['error'])}")
    return data.get("result")


def mcp_list_tools() -> list[dict]:
    """The live, role-filtered tool list for the demo user. Empty is a valid,
    honest answer (e.g. their role can't see any tool) — never faked."""
    result = mcp_call("tools/list")
    return (result or {}).get("tools", [])


def mcp_call_tool(name: str, arguments: dict) -> str:
    """Returns the tool's text content, or an honest error string — MCP tool
    errors are typed content, not transport failures (see server.ts toolError)."""
    result = mcp_call("tools/call", {"name": name, "arguments": arguments})
    content = (result or {}).get("content") or []
    text = "\n".join(c.get("text", "") for c in content if c.get("type") == "text")
    if result and result.get("isError"):
        return f"[tool error] {text or 'denied'}"
    return text or "(empty result)"


def mcp_tools_as_openai_functions(tools: list[dict]) -> list[dict]:
    """MCP's {name, description, inputSchema} maps directly onto OpenAI's
    function-calling shape — no reshaping of the schema itself needed."""
    return [
        {
            "type": "function",
            "function": {
                "name": t["name"],
                "description": t.get("description", ""),
                "parameters": t.get("inputSchema") or {"type": "object", "properties": {}},
            },
        }
        for t in tools
    ]


# ---- answer loop -------------------------------------------------------------
def answer_question(question: str) -> dict:
    tools = mcp_list_tools()
    openai_tools = mcp_tools_as_openai_functions(tools)

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": question},
    ]
    resp = client.chat.completions.create(
        model=CHAT_MODEL,
        messages=messages,
        tools=openai_tools or None,
    )
    msg = resp.choices[0].message
    tools_called = []

    if msg.tool_calls:
        messages.append(msg.model_dump(exclude_none=True))
        for tc in msg.tool_calls:
            args = json.loads(tc.function.arguments or "{}")
            result_text = mcp_call_tool(tc.function.name, args)
            tools_called.append(tc.function.name)
            messages.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": result_text,
            })
        resp = client.chat.completions.create(model=CHAT_MODEL, messages=messages)
        msg = resp.choices[0].message

    return {"answer": msg.content or "", "tools_available": [t["name"] for t in tools], "tools_called": tools_called}


@observe(name="mcp-test-agent")
def run(question: str) -> dict:
    result = answer_question(question)
    if LANGFUSE_ENABLED:
        try:
            get_client().update_current_trace(
                input=question, output=result["answer"], tags=["mcp-test-agent"],
                metadata={"tools_available": result["tools_available"], "tools_called": result["tools_called"]},
            )
        except Exception:
            pass
    return result


def flush_traces():
    if LANGFUSE_ENABLED:
        try:
            get_client().flush()
        except Exception:
            pass


# ---- HTTP API ----------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print("[mcp-test-agent] " + (fmt % args))

    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path in ("/health", "/healthz", "/"):
            return self._send(200, {"status": "ok", "langfuse": LANGFUSE_ENABLED, "mcp_url": MCP_URL})
        if u.path == "/ask":
            q = (parse_qs(u.query).get("q") or [""])[0]
            return self._ask(q)
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        u = urlparse(self.path)
        if u.path == "/ask":
            length = int(self.headers.get("Content-Length", "0") or "0")
            req = json.loads(self.rfile.read(length) or b"{}")
            return self._ask(req.get("question", ""))
        return self._send(404, {"error": "not found"})

    def _ask(self, question):
        if not question:
            return self._send(400, {"error": "missing question"})
        if not MCP_TOKEN:
            return self._send(500, {"error": "MCP_TOKEN not configured"})
        try:
            result = run(question)
            flush_traces()
            return self._send(200, {"question": question, "traced_in_langfuse": LANGFUSE_ENABLED, **result})
        except Exception as e:
            traceback.print_exc()
            return self._send(500, {"error": str(e)})


def main():
    print(f"[mcp-test-agent] starting on :{PORT} (mcp={MCP_URL}, chat={CHAT_MODEL}, "
          f"token_configured={bool(MCP_TOKEN)})")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
