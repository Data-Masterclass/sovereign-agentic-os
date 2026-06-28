# Poet agent

**What it is:** A second LangGraph agent (compose → save) that asks the model (via LiteLLM)
for a short poem and **writes it to a file** each run — a simple "open a file to see it
worked" demo. Traced in Langfuse.

## Access
```bash
kubectl -n agentic-os run p --rm -i --restart=Never --image=curlimages/curl:8.11.1 -- \
  curl -sS http://poet-agent:8000/write -G --data-urlencode "topic=the alps at dawn"
```
Poems are written to a persistent volume. Pull them out: `./scripts/get-poems.sh` → `./poems/`.

## FAQ
**Q: Where are the files?** On the poet's PVC at `/data/poems`; `get-poems.sh` copies them to
`./poems/` on your machine.
**Q: Same architecture as the RAG agent?** Yes — LangGraph → LiteLLM → Langfuse; it just
writes output to a file instead of doing RAG.
