# Mock model — local offline LLM

**What it is:** A tiny, dependency-free **OpenAI-compatible** server (chat + embeddings) that
LiteLLM routes to, so the whole OS runs **fully offline with no provider key** (sovereign demo).
Chat answers echo the grounded context; embeddings are deterministic hashes (so kNN works).

## Access
It sits behind LiteLLM — you normally call `sovereign-mock` / `sovereign-embed` via LiteLLM.
Direct: `http://mock-model:8080/v1/chat/completions`.

## FAQ
**Q: Why does it not write real prose?** It's a stub for offline demos. Swap in a real model
in LiteLLM (`model_list`) — no agent changes needed.
**Q: Replace it with STACKIT AI Model Serving?** Yes — set `llm.mode: external` and add the
model to LiteLLM; disable the mock.
