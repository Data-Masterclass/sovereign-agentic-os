# Mock model — local offline embeddings (+ legacy chat stub)

**What it is:** A tiny, dependency-free **OpenAI-compatible** server. Since the self-hosted
[model-server](model-server.md) (**Gemma E4B**) became the default **chat** backend, the mock is
retained as the offline **embeddings** provider (`sovereign-embed`): deterministic 384-dim hash
vectors that match `opensearch.knnDimension` with zero download and no key (so kNN works). It still
exposes a chat stub, but LiteLLM **no longer routes chat to it**.

## Access
It sits behind LiteLLM — you normally call `sovereign-embed` via LiteLLM (chat goes to
`sovereign-default`). Direct: `http://mock-model:8080/v1/embeddings`.

## FAQ
**Q: Why does it not write real prose?** It's a stub for offline demos. Swap in a real model
in LiteLLM (`model_list`) — no agent changes needed.
**Q: Replace it with STACKIT AI Model Serving?** Yes — set `llm.mode: external` and add the
model to LiteLLM; disable the mock.
