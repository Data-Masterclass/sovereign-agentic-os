#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""
Sovereign mock model — a tiny OpenAI-compatible server (chat + embeddings).

Fully offline/sovereign: no external calls, no dependencies (Python stdlib only).
It stands in for a real model behind LiteLLM so the agent-core slice can be
validated end-to-end without any provider key.

Endpoints (LiteLLM calls these via an openai/* model with api_base=.../v1):
  POST /v1/chat/completions  -> a deterministic, CONTEXT-AWARE answer, so RAG
                                context retrieved from OpenSearch is visibly used.
  POST /v1/embeddings        -> deterministic hash/bag-of-words embeddings, so
                                lexical overlap drives cosine similarity (good
                                enough for a real kNN RAG demo).
  GET  /v1/models, /health   -> trivial.
"""
import hashlib
import json
import os
import random
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

EMBED_DIM = int(os.environ.get("EMBED_DIM", "384"))
_token_re = re.compile(r"[a-z0-9]+")

# --- tiny poem generator (offline; varied per call) ------------------------
_ADJ = ["silent", "golden", "drifting", "sovereign", "quiet", "electric",
        "ancient", "gentle", "boundless", "humming", "luminous", "patient"]
_NOUN = ["server", "meadow", "cluster", "river", "circuit", "mountain",
         "signal", "garden", "harbor", "lantern", "current", "valley"]
_VERB = ["hums", "drifts", "dreams", "glows", "whispers", "spins",
         "waits", "sings", "wanders", "kindles", "listens", "rises"]


def _extract_topic(text: str) -> str:
    m = re.search(r"about\s+([\w '\-]+)", text, re.IGNORECASE)
    topic = (m.group(1).strip() if m else "the sovereign cloud")
    # trim trailing filler words/punctuation
    return re.sub(r"[.?!,;:]+$", "", topic).strip() or "the sovereign cloud"


def make_poem(topic: str) -> str:
    r = random.Random()  # time-seeded -> a different poem each run
    return "\n".join([
        f"{r.choice(_ADJ).capitalize()} {topic}, you {r.choice(_VERB)} through the {r.choice(_NOUN)},",
        f"a {r.choice(_ADJ)} {r.choice(_NOUN)} where the {r.choice(_NOUN)}s {r.choice(_VERB)}.",
        f"In {r.choice(_ADJ)} light the {r.choice(_NOUN)} {r.choice(_VERB)} on,",
        f"and {topic} {r.choice(_VERB)} softly till the night is gone.",
    ])


def embed(text: str):
    """Deterministic bag-of-words embedding, L2-normalized.

    Each token is hashed into a bucket; shared vocabulary -> close vectors.
    Stable across calls, so a query embeds near documents that share words.
    """
    vec = [0.0] * EMBED_DIM
    for tok in _token_re.findall((text or "").lower()):
        h = int(hashlib.md5(tok.encode()).hexdigest(), 16)
        vec[h % EMBED_DIM] += 1.0
    norm = sum(v * v for v in vec) ** 0.5
    if norm > 0:
        vec = [v / norm for v in vec]
    return vec


def _last_user_and_context(messages):
    """Pull the last user message and any provided context block."""
    user = ""
    for m in messages or []:
        if m.get("role") == "user":
            c = m.get("content")
            user = c if isinstance(c, str) else json.dumps(c)
    # The agent passes retrieved context inside the user/system prompt; surface a
    # short slice of it so the trace + answer prove the context flowed through.
    return user


def chat_answer(messages):
    user = _last_user_and_context(messages)
    full = " ".join(
        m.get("content", "") for m in (messages or [])
        if isinstance(m.get("content"), str)
    ).lower()
    # Poem mode: if asked for a poem, write a short varied one.
    if "poem" in full:
        return make_poem(_extract_topic(user))
    # Otherwise: deterministic, context-grounded echo (used by the RAG demo).
    snippet = " ".join(user.split())[:400]
    return (
        "[sovereign-mock] Answer grounded in the provided context. "
        f"Prompt+context seen ({len(user)} chars): {snippet}"
    )


def _count_tokens(text: str) -> int:
    return max(1, len(_token_re.findall((text or "").lower())))


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # quieter logs
        print("[mock-model] " + (fmt % args))

    def do_GET(self):
        if self.path in ("/health", "/healthz", "/"):
            return self._send(200, {"status": "ok"})
        if self.path.rstrip("/").endswith("/models"):
            return self._send(200, {
                "object": "list",
                "data": [
                    {"id": "mock-gpt", "object": "model", "owned_by": "sovereign"},
                    {"id": "mock-embed", "object": "model", "owned_by": "sovereign"},
                ],
            })
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            req = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return self._send(400, {"error": "invalid json"})

        path = self.path.rstrip("/")
        if path.endswith("/chat/completions"):
            messages = req.get("messages", [])
            content = chat_answer(messages)
            prompt_tokens = sum(_count_tokens(str(m.get("content", ""))) for m in messages)
            completion_tokens = _count_tokens(content)
            return self._send(200, {
                "id": "chatcmpl-mock-0001",
                "object": "chat.completion",
                "created": 0,
                "model": req.get("model", "mock-gpt"),
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": content},
                    "finish_reason": "stop",
                }],
                "usage": {
                    "prompt_tokens": prompt_tokens,
                    "completion_tokens": completion_tokens,
                    "total_tokens": prompt_tokens + completion_tokens,
                },
            })

        if path.endswith("/embeddings"):
            inp = req.get("input", "")
            items = inp if isinstance(inp, list) else [inp]
            data = []
            total = 0
            for i, text in enumerate(items):
                total += _count_tokens(str(text))
                data.append({"object": "embedding", "index": i, "embedding": embed(str(text))})
            return self._send(200, {
                "object": "list",
                "data": data,
                "model": req.get("model", "mock-embed"),
                "usage": {"prompt_tokens": total, "total_tokens": total},
            })

        return self._send(404, {"error": "not found"})


def main():
    port = int(os.environ.get("PORT", "8080"))
    print(f"[mock-model] listening on :{port} (EMBED_DIM={EMBED_DIM})")
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
