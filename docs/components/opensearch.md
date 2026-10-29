# OpenSearch — retrieval backbone

**What it is:** OpenSearch (Apache 2.0) is the **vector + lexical** retrieval store — the RAG
backbone for the agents and (in production) the catalog search for OpenMetadata. No pgvector.
Single node locally, security plugin disabled (the default-deny network baseline guards it).

## Access (API, no UI here — see OpenSearch Dashboards for a UI)
```bash
kubectl -n agentic-os port-forward svc/opensearch 9200:9200
curl http://localhost:9200/_cluster/health?pretty
curl http://localhost:9200/knowledge/_search?pretty     # the agents' RAG docs
```

## How to use it
- **Inspect the knowledge index** (`knowledge`) — the docs the sample agent retrieves.
- **kNN search**, index management, mappings — all via the REST API (or Dashboards if enabled).
- **Haystack** runs RAG pipelines over it; the agents query it for context.

## FAQ
**Q: No auth?** The security plugin is disabled locally for simplicity; the default-deny
NetworkPolicies + in-cluster-only service protect it. On STACKIT, enable security + TLS.
**Q: Want a UI?** Enable **OpenSearch Dashboards** (off by default locally) — see its doc.
**Q: Why not pgvector?** Decided: OpenSearch is the single hybrid retrieval + catalog-search
backbone (stack-decisions.md).
