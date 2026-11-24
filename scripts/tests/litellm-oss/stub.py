# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# A minimal OpenAI-compatible model provider for scripts/tests/litellm-oss/run.sh (stdlib only).
# /v1/chat/completions answers "stub-ok:<model>" with fixed usage (so spend is non-zero with the
# probe's prices); /v1/embeddings answers a 4-dim vector; /v1/models lists one model.
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class H(BaseHTTPRequestHandler):
    def _send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            return self._send(200, {"object": "list", "data": [{"id": "stub", "object": "model"}]})
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", "0")) or 0) or b"{}")
        model = body.get("model", "?")
        if self.path.endswith("/chat/completions"):
            return self._send(200, {
                "id": "chatcmpl-stub", "object": "chat.completion", "created": int(time.time()), "model": model,
                "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": f"stub-ok:{model}"}}],
                "usage": {"prompt_tokens": 1000, "completion_tokens": 500, "total_tokens": 1500},
            })
        if self.path.endswith("/embeddings"):
            return self._send(200, {"object": "list", "model": model, "data": [{"object": "embedding", "index": 0, "embedding": [0.1, 0.2, 0.3, 0.4]}],
                                    "usage": {"prompt_tokens": 3, "total_tokens": 3}})
        return self._send(404, {"error": "not found"})

    def log_message(self, *a):
        pass


ThreadingHTTPServer(("0.0.0.0", 8080), H).serve_forever()
