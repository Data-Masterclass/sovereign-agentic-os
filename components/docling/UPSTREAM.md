# Docling

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`.

- **Licence:** MIT (docling, docling-serve, docling-core, docling-jobkit)
- **Source:** https://github.com/docling-project/docling-serve (service), https://github.com/docling-project/docling (library)
- **Pinned as:** base image `quay.io/docling-project/docling-serve-cpu:v1.38.2@sha256:7a480a1604fa3b42efeddc7db9527690d9f9bc903226136013e2bfe6b1a4dfb0`
  (release v1.38.2, published 2026-10-27 — the latest release on 2026-11-20; multi-arch manifest list).
- **Deployed as:** our derived image `ghcr.io/data-masterclass/sovereign-os/docling:1.38.2-<n>`,
  built from `images/extensions/docling/Dockerfile` (`FROM` the pin above). It adds model weights
  and removes one set; it changes no upstream code.

**Why the OS ships it:** PDF/Office text extraction for the Files and Knowledge tabs.

## Docs used

- Configuration (all `DOCLING_SERVE_*` settings): https://github.com/docling-project/docling-serve/blob/v1.38.2/docs/configuration.md
- Usage (convert options, `table_structure_preset`): https://github.com/docling-project/docling-serve/blob/v1.38.2/docs/usage.md
- Routes, `/ready`, `/livez`, `/version`: https://github.com/docling-project/docling-serve/blob/v1.38.2/docling_serve/app.py
- API key (`X-Api-Key`, 401): https://github.com/docling-project/docling-serve/blob/v1.38.2/docling_serve/auth.py
- Image build and baked `MODELS_LIST`: https://github.com/docling-project/docling-serve/blob/v1.38.2/Containerfile
- Model download CLI (`docling-tools models download`): https://github.com/docling-project/docling/blob/main/docling/cli/models.py

## Model weights in the deployed image

Checked against the Hugging Face model API, GitHub and ModelScope on 2026-11-20.

| Weights | Source | Licence | In our image |
|---|---|---|---|
| Layout (Heron) | `docling-project/docling-layout-heron` (HF) | Apache-2.0 | Yes (upstream) |
| **TableFormer v2** | `docling-project/TableFormerV2` (HF) | Apache-2.0 | **Yes (added by us)** |
| TableFormer v1 | `docling-project/docling-models` (HF) | CDLA-Permissive-2.0 + Apache-2.0 | **No — removed** (CDLA-Permissive-2.0 is not on the allowlist; owner decision O9) |
| Picture classifier | `docling-project/DocumentFigureClassifier-v2.0` (HF) | Apache-2.0 | Yes (upstream) |
| RapidOCR (PP-OCR det/cls/rec) | `RapidAI/RapidOCR` (ModelScope), models from PaddleOCR | Apache-2.0 (RapidOCR and PaddleOCR) | Yes (upstream) |
| EasyOCR (`english_g2`, `latin_g2`, CRAFT) | JaidedAI/EasyOCR releases | Apache-2.0 (repository licence) | Yes (upstream) |
| MiniLM tokenizer (HybridChunker) | `sentence-transformers/all-MiniLM-L6-v2` (HF, rev `1110a243fdf4706b3f48f1d95db1a4f5529b4d41`) | Apache-2.0 | **Yes (added by us; tokenizer files only)** |

Every conversion request sends `table_structure_preset=tableformer_v2`
(`os-ui/tabs/files/lib/ingest/docling-client.ts`).

The `-cpu` base is built on CentOS Stream 9 (`quay.io/sclorg/python-312-c9s`), freely
redistributable.

The deployment that uses this pin lives in the chart
(`charts/sovereign-agentic-os/templates/extensions/docling/`); any glue we wrote belongs there,
in `images/extensions/docling/`, or in the owning tab, never here.
