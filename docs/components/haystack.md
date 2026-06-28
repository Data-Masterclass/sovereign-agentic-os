# Haystack — RAG retrieval pipeline

**What it is:** Haystack (Apache 2.0) runs the **RAG retrieval pipeline** over OpenSearch,
embedding via the LiteLLM gateway. Scope = retrieval; LangGraph keeps the agent control flow.
Uses its own `haystack_knowledge` index.

## Access
```bash
kubectl -n agentic-os run h --rm -i --restart=Never --image=curlimages/curl:8.11.1 -- \
  curl -sS http://haystack:8000/retrieve -G --data-urlencode "q=which component runs the RAG pipelines?"
```
Returns the top-ranked documents with scores.

## FAQ
**Q: Haystack vs the agent's own retrieval?** Haystack is a reusable retrieval service; agents
can call it or do their own kNN. It demonstrates the pipeline pattern over OpenSearch.
**Q: Embeddings?** Through LiteLLM (`sovereign-embed`) — same gateway as everything else.
