# Docling — document parsing

**What it is:** Docling (MIT) — a doc-parsing service (`docling-serve`) that converts uploaded
documents (PDF/DOCX/HTML…) into clean **markdown** for the knowledge index. **Off by default
locally** (RAM); on by default for STACKIT.

## Enable it
Turn it on in the Admin Console, or set `docling.enabled: true` and `helm upgrade`.

## Access (API)
```bash
kubectl -n agentic-os port-forward svc/docling 5001:5001
# POST /v1/convert/source with a base64 file -> markdown
```

## FAQ
**Q: Why off locally?** It pulls ML models and is RAM-heavy; toggled off so the full L1–L3
slice fits a 14 GB kind VM.
**Q: How does it feed RAG?** Parsed markdown → embedded → OpenSearch knowledge index → agents' RAG.
