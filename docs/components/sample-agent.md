# Sample RAG agent

**What it is:** A LangGraph agent (the MIT library) that proves the agent-core loop:
**retrieve** (kNN over OpenSearch) → **generate** (via LiteLLM) → **trace** (Langfuse). It
treats retrieved context as *data, not instructions* (prompt-injection defense).

## Access (HTTP service, no UI)
```bash
kubectl -n agentic-os run ask --rm -i --restart=Never --image=curlimages/curl:8.11.1 -- \
  curl -sS http://sample-agent:8000/ask -G --data-urlencode "q=What is the retrieval backbone?"
```
Returns the answer, the retrieved knowledge titles, and `traced_in_langfuse: true`.

## How to use it
- **Ask questions** via `/ask?q=...`. The seed knowledge covers the OS itself
  (retrieval backbone, model gateway, observability, sovereignty).
- **Watch the trace:** open Langfuse → the `rag-agent` trace shows retrieve + generate spans.
- **Edit the knowledge:** `sampleAgent.knowledge` in values (re-ingested on restart).

## FAQ
**Q: Answers look canned.** The bundled LLM is the offline **mock model** — it echoes the
grounded context. Point LiteLLM at a real model for natural answers (no agent change).
**Q: It uses which model/key?** `sovereign-mock` + `sovereign-embed` via the scoped agent key.
**Q: How does it find the right doc?** Embeddings (mock = deterministic hash) → OpenSearch kNN.
