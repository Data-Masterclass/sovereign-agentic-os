# OpenSearch Dashboards

**What it is:** The Kibana-equivalent **search/visualization UI** over OpenSearch — inspect the
RAG/knowledge indices, run queries (Dev Tools), manage indices. **Off by default locally.**

## Enable it
Toggle on in the Admin Console, or `osdashboards.enabled: true` + `helm upgrade`.

## Access (UI)
```bash
kubectl -n agentic-os port-forward svc/opensearch-dashboards 5601:5601
# http://localhost:5601  (no login — security disabled locally)
```

## How to use it
- **Dev Tools:** `GET knowledge/_search` to see the agents' RAG docs; run kNN queries.
- **Discover:** create an index pattern (`knowledge`) to browse documents.

## FAQ
**Q: Business BI?** No — that's Superset. Dashboards is the ops/search console for OpenSearch.
**Q: Why off locally?** ~0.5–1 GB Node.js app; toggled off for RAM (on for STACKIT).
