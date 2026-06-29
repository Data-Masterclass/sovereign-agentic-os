#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""
agent-runtime — the shared Python IR interpreter behind the Sovereign Agentic OS
Agents tab live execution (Approach A). os-ui's TypeScript ``compile()`` is the
single source of graph semantics; it POSTs the compiled IR here (`/reload`) and
drives one synchronous invocation per Run (`/run`). This service is a GENERIC IR
INTERPRETER, never a second compiler.

It holds NO resource creds and NO OPA/Langfuse access of its own: every tool call
funnels back through the os-ui governed-tool endpoint, which owns authorize +
trace + creds. Model calls go via LiteLLM ONLY (OpenAI-compatible client).

Plain stdlib HTTP server (no web framework) to keep the image lean — matches the
sample-agent / poet-agent convention. The graph-walk logic lives in
``interpreter.py`` and is unit-tested hermetically.
"""
import hmac
import json
import os
import sys
import threading
import traceback
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

import interpreter

# ---- config (from env / ConfigMap / Secret) --------------------------------
LITELLM_BASE = os.environ.get("LITELLM_BASE_URL", "http://agentic-os-litellm:4000/v1")
LITELLM_KEY = os.environ.get("LITELLM_API_KEY", "")  # the SCOPED virtual key
CHAT_MODEL = os.environ.get("CHAT_MODEL", "sovereign-mock")
# The OS UI in-cluster Service is `os-ui` (chart-owned, NOT release-prefixed).
GOVERNED_TOOL_URL = os.environ.get("GOVERNED_TOOL_URL", "http://os-ui:3000/api/agents/tool")
AGENT_RUNTIME_TOKEN = os.environ.get("AGENT_RUNTIME_TOKEN", "")
PORT = int(os.environ.get("PORT", "8000"))


def _authorized(headers):
    """Gate /reload + /run with the shared runtime bearer — the SAME token the
    runtime presents to os-ui. Without it, any in-namespace pod could POST a
    crafted IR and drive governed-tool calls. When no token is configured (local
    dev) the check is skipped. Constant-time compared."""
    if not AGENT_RUNTIME_TOKEN:
        return True
    got = (headers.get("Authorization") or "")
    got = got[7:].strip() if got[:7].lower() == "bearer " else got.strip()
    return hmac.compare_digest(got, AGENT_RUNTIME_TOKEN)

# In-memory store of reloaded IRs keyed by systemId. The build adapter re-POSTs
# /reload whenever a system changes, so this is intentionally ephemeral.
_systems = {}
_lock = threading.Lock()


def do_reload(body):
    system_id = body.get("systemId")
    ir = body.get("ir")
    if not system_id:
        return 400, {"ok": False, "error": "systemId is required"}
    ok, err = interpreter.validate_ir(ir)
    if not ok:
        return 400, {"ok": False, "error": err}
    with _lock:
        _systems[system_id] = ir
    return 200, {
        "ok": True,
        "systemId": system_id,
        "nodes": len(ir.get("nodes", [])),
        "entrypoint": ir.get("entrypoint"),
    }


def do_run(body):
    system_id = body.get("systemId")
    with _lock:
        ir = _systems.get(system_id)
    if ir is None:
        return 404, {"ok": False, "error": "system not reloaded"}

    prompt = body.get("prompt", "")
    recursion_limit = int(body.get("recursionLimit", 25))
    timeout_ms = int(body.get("timeoutMs", 60000))
    disabled = body.get("disabledAgents", []) or []

    model_call = interpreter.make_model_call(LITELLM_BASE, LITELLM_KEY, CHAT_MODEL)
    tool_call = interpreter.make_tool_call(GOVERNED_TOOL_URL, AGENT_RUNTIME_TOKEN, system_id)

    result = interpreter.run_ir(
        ir,
        prompt=prompt,
        recursion_limit=recursion_limit,
        timeout_ms=timeout_ms,
        disabled_agents=disabled,
        model_call=model_call,
        tool_call=tool_call,
    )
    return 200, result


# ---- HTTP API --------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print("[agent-runtime] " + (fmt % args))

    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self):
        u = urlparse(self.path)
        if u.path in ("/health", "/healthz", "/"):
            with _lock:
                count = len(_systems)
            return self._send(200, {"status": "ok", "systems": count, "model": CHAT_MODEL})
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        u = urlparse(self.path)
        if u.path in ("/reload", "/run") and not _authorized(self.headers):
            return self._send(401, {"ok": False, "error": "unauthorized"})
        try:
            if u.path == "/reload":
                code, payload = do_reload(self._read_json())
                return self._send(code, payload)
            if u.path == "/run":
                code, payload = do_run(self._read_json())
                return self._send(code, payload)
            return self._send(404, {"error": "not found"})
        except Exception as e:
            traceback.print_exc()
            return self._send(500, {"ok": False, "error": str(e)})


def main():
    print("[agent-runtime] starting on :%d (model=%s, litellm=%s, governed=%s)"
          % (PORT, CHAT_MODEL, LITELLM_BASE, GOVERNED_TOOL_URL))
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
