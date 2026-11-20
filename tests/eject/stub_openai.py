# Minimal OpenAI-compatible chat stub: first call of a conversation asks for one tool, then answers.
import json, http.server, itertools
ids = itertools.count(1)
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['content-length'])))
        msgs = body.get('messages', []); tools = [t['function']['name'] for t in body.get('tools', [])]
        has_tool_result = any(m.get('role') == 'tool' for m in msgs)
        want = next((t for t in tools if t == 'search_knowledge'), None)
        if want and not has_tool_result:
            msg = {"role": "assistant", "content": None, "tool_calls": [{"id": f"call_{next(ids)}", "type": "function", "function": {"name": want, "arguments": json.dumps({"query": "revenue"})}}]}
            fr = "tool_calls"
        else:
            msg = {"role": "assistant", "content": "stub answer: revenue reviewed"}; fr = "stop"
        out = {"id": "x", "object": "chat.completion", "created": 0, "model": body.get("model", "stub"), "choices": [{"index": 0, "message": msg, "finish_reason": fr}], "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}
        b = json.dumps(out).encode(); self.send_response(200); self.send_header('content-type', 'application/json'); self.send_header('content-length', str(len(b))); self.end_headers(); self.wfile.write(b)
http.server.ThreadingHTTPServer(('0.0.0.0', 8000), H).serve_forever()
