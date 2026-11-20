# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# AREA:       acceptance harness (tests/e2e/kind)
# FEATURE:    Scripted OpenAI-compatible model upstream with a request counter
# USER STORY: As the acceptance harness I want the ONLY faked hop to be the model itself, and I
#             want to know exactly how many model calls reached it, so a journey can assert
#             "exactly N GENERATION observations in Langfuse, N = the stub's count" (AT-a step 5).
# ARCHITECTURE:
#   - Stdlib only (no dependencies). LiteLLM routes to it through the chart's `mock-model`
#     Service; values.e2e.yaml swaps only the image.
#   - Chat replies come from a script loaded over HTTP (POST /__stub/script). Steps are consumed
#     in order. A step may pin `match` (a substring the last message must contain); a mismatch
#     or an exhausted script is HTTP 409 with a typed error, never a made-up answer.
#   - With no script loaded, chat answers a fixed, labelled sentence (health probes only).
#   - Embeddings are deterministic (hashed bag of words, L2-normalised, EMBED_DIM wide).
#   - Every request is counted and logged (GET /__stub/stats, GET /__stub/requests).
import hashlib
import json
import math
import os
import re
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8080"))
EMBED_DIM = int(os.environ.get("EMBED_DIM", "384"))
NO_SCRIPT_REPLY = "e2e-model-stub: no script loaded"

_lock = threading.Lock()
_state = {"script": None, "cursor": 0, "requests": [], "counts": {}}


def _reset():
    _state.update({"script": None, "cursor": 0, "requests": [], "counts": {}})


def _count(kind, entry):
    with _lock:
        _state["counts"][kind] = _state["counts"].get(kind, 0) + 1
        entry["seq"] = len(_state["requests"]) + 1
        _state["requests"].append(entry)


def embed(text):
    vec = [0.0] * EMBED_DIM
    for tok in re.findall(r"[a-z0-9]+", (text or "").lower()):
        h = int(hashlib.sha256(tok.encode()).hexdigest(), 16)
        vec[h % EMBED_DIM] += 1.0 if (h >> 8) & 1 else -1.0
    norm = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [v / norm for v in vec]


def _text_of(message):
    content = message.get("content")
    if isinstance(content, list):
        return " ".join(p.get("text", "") for p in content if isinstance(p, dict))
    return content or ""


def _next_step(messages):
    """Return (step, error). error is a (code, reason) tuple when the script refuses."""
    with _lock:
        script = _state["script"]
        if script is None:
            return {"reply": {"content": NO_SCRIPT_REPLY}}, None
        steps = script.get("steps", [])
        if _state["cursor"] >= len(steps):
            return None, ("stub_script_exhausted", f"script has {len(steps)} steps, all consumed")
        step = steps[_state["cursor"]]
        last = _text_of(messages[-1]) if messages else ""
        if step.get("match") and step["match"] not in last:
            return None, ("stub_script_mismatch", f"step {_state['cursor'] + 1} expects {step['match']!r} in the last message")
        _state["cursor"] += 1
        return step, None


def _completion(model, reply):
    message = {"role": "assistant", "content": reply.get("content")}
    finish = "stop"
    if reply.get("tool_calls"):
        message["tool_calls"] = [
            {
                "id": f"call_{uuid.uuid4().hex[:12]}",
                "type": "function",
                "function": {"name": tc["name"], "arguments": json.dumps(tc.get("arguments", {}))},
            }
            for tc in reply["tool_calls"]
        ]
        finish = "tool_calls"
    prompt_tokens, completion_tokens = 10, len((reply.get("content") or "").split()) + 1
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "message": message, "finish_reason": finish}],
        "usage": {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens,
                  "total_tokens": prompt_tokens + completion_tokens},
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _json(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        try:
            return json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return None

    def log_message(self, fmt, *args):
        print("stub", self.command, self.path, flush=True)

    def do_GET(self):
        path = self.path.rstrip("/")
        if path in ("", "/health", "/healthz"):
            return self._json(200, {"status": "ok"})
        if path.endswith("/models"):
            return self._json(200, {"object": "list", "data": [{"id": "e2e-stub", "object": "model"}]})
        if path == "/__stub/stats":
            with _lock:
                return self._json(200, {"counts": dict(_state["counts"]), "cursor": _state["cursor"],
                                        "script_loaded": _state["script"] is not None,
                                        "total": len(_state["requests"])})
        if path == "/__stub/requests":
            with _lock:
                return self._json(200, {"requests": list(_state["requests"])})
        return self._json(404, {"error": {"code": "not_found", "message": self.path}})

    def do_POST(self):
        path = self.path.rstrip("/")
        body = self._body()
        if body is None:
            return self._json(400, {"error": {"code": "bad_json", "message": "request body is not JSON"}})
        if path == "/__stub/script":
            if not isinstance(body.get("steps"), list):
                return self._json(400, {"error": {"code": "bad_script", "message": "steps[] required"}})
            with _lock:
                _state["script"], _state["cursor"] = body, 0
            return self._json(200, {"loaded": len(body["steps"])})
        if path == "/__stub/reset":
            with _lock:
                _reset()
            return self._json(200, {"reset": True})

        entry = {"path": path, "at": time.time(), "model": body.get("model"), "user": body.get("user"),
                 "headers": {k.lower(): v for k, v in self.headers.items()
                             if k.lower().startswith(("x-litellm", "traceparent", "x-request-id"))}}
        if path.endswith("/embeddings"):
            inputs = body.get("input")
            inputs = inputs if isinstance(inputs, list) else [inputs]
            _count("embeddings", entry)
            data = [{"object": "embedding", "index": i, "embedding": embed(str(t))} for i, t in enumerate(inputs)]
            return self._json(200, {"object": "list", "data": data, "model": body.get("model"),
                                    "usage": {"prompt_tokens": len(inputs), "total_tokens": len(inputs)}})
        if path.endswith("/chat/completions"):
            _count("chat", entry)
            step, err = _next_step(body.get("messages") or [])
            if err:
                entry["error"] = err[0]
                return self._json(409, {"error": {"code": err[0], "message": err[1], "type": "stub_script"}})
            completion = _completion(body.get("model") or "e2e-stub", step["reply"])
            entry["completion_id"] = completion["id"]
            if body.get("stream"):
                return self._stream(completion)
            return self._json(200, completion)
        return self._json(404, {"error": {"code": "not_found", "message": self.path}})

    def _stream(self, completion):
        choice = completion["choices"][0]
        delta = {"role": "assistant", "content": choice["message"].get("content")}
        if choice["message"].get("tool_calls"):
            delta["tool_calls"] = [dict(tc, index=i) for i, tc in enumerate(choice["message"]["tool_calls"])]
        chunks = [
            {"id": completion["id"], "object": "chat.completion.chunk", "created": completion["created"],
             "model": completion["model"], "choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
            {"id": completion["id"], "object": "chat.completion.chunk", "created": completion["created"],
             "model": completion["model"], "choices": [{"index": 0, "delta": {}, "finish_reason": choice["finish_reason"]}],
             "usage": completion["usage"]},
        ]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        for c in chunks:
            self.wfile.write(f"data: {json.dumps(c)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.close_connection = True


if __name__ == "__main__":
    print(f"e2e-model-stub listening on :{PORT} (embed dim {EMBED_DIM})", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
