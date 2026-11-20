# Docling

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`.

- **Licence:** MIT (docling, docling-serve, docling-core, docling-jobkit)
- **Source:** https://github.com/docling-project/docling-serve (service), https://github.com/docling-project/docling (library)
- **Pinned as:** base image `quay.io/docling-project/docling-serve-cpu:v1.38.2@sha256:7a480a1604fa3b42efeddc7db9527690d9f9bc903226136013e2bfe6b1a4dfb0`
  (release v1.38.2, published 2026-10-27 — the latest release on 2026-11-20; multi-arch manifest list).
- **Deployed as:** our derived image `ghcr.io/data-masterclass/sovereign-os/docling:1.38.2-<n>@sha256:…`,
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

Checked against the Hugging Face model API, GitHub and ModelScope on 2026-11-20. The image build
prints the model folder listing (`find $DOCLING_SERVE_ARTIFACTS_PATH -maxdepth 3 -type d`) into the
`build-images` / `docling-live` CI log, so this table can be checked against what shipped.

| Folder | Source | Licence | In our image |
|---|---|---|---|
| `docling-project--docling-layout-heron` | HF `docling-project/docling-layout-heron` | Apache-2.0 | Yes (upstream) |
| `docling-project--docling-layout-heron-onnx` | HF `docling-project/docling-layout-heron-onnx` (the ONNX engine override the downloader also fetches) | Apache-2.0 | Yes (upstream) |
| `docling-project--TableFormerV2` | HF `docling-project/TableFormerV2` @ `e41ba5da7ef69004f4b329168791c2987abf917c` (licence from the model card; the repo has no LICENSE file; the card calls it a preview model, hence the pinned revision) | Apache-2.0 | **Yes (added by us)** |
| `docling-project--docling-models` (TableFormer v1) | HF `docling-project/docling-models` | CDLA-Permissive-2.0 + Apache-2.0 | **No — removed** (CDLA-Permissive-2.0 is not on the allowlist; owner decision O9) |
| `docling-project--DocumentFigureClassifier-v2.5` | HF `docling-project/DocumentFigureClassifier-v2.5` (preset `document_figure_classifier_v2`) | MIT | Yes (upstream) |
| `RapidOcr/…` (PP-OCRv4 det/cls/rec) | `RapidAI/RapidOCR` (ModelScope), models from PaddleOCR | Apache-2.0 (RapidOCR and PaddleOCR) | Yes (upstream) |
| `EasyOcr/craft_mlt_25k.pth` (text detector) | JaidedAI/EasyOCR release, weights from clovaai/CRAFT-pytorch | MIT (CRAFT-pytorch) | Yes (upstream) |
| `EasyOcr/english_g2.pth`, `EasyOcr/latin_g2.pth` (recognisers) | JaidedAI/EasyOCR releases | Apache-2.0 | Yes (upstream) |
| HF cache `sentence-transformers/all-MiniLM-L6-v2` @ `1110a243fdf4706b3f48f1d95db1a4f5529b4d41` (5 tokenizer files) | HF | Apache-2.0 | **Yes (added by us)** |

The table model is fixed server-side with docling-serve's documented settings
(`docs/configuration.md`): `DOCLING_SERVE_DEFAULT_TABLE_STRUCTURE_PRESET=tableformer_v2` and
`DOCLING_SERVE_ALLOWED_TABLE_STRUCTURE_PRESETS=["tableformer_v2"]`, so a v1 request is refused and
the boot warm-up (`LOAD_MODELS_AT_BOOT`, default on) loads v2 before `/ready` answers 200.

The `-cpu` base is built on CentOS Stream 9 (`quay.io/sclorg/python-312-c9s`), freely
redistributable.

The deployment that uses this pin lives in the chart
(`charts/sovereign-agentic-os/templates/extensions/docling/`); any glue we wrote belongs there,
in `images/extensions/docling/`, or in the owning tab, never here.
