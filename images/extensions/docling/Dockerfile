# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# docling — upstream docling-serve-cpu, with the model weights the OS's licence policy allows.
#
# WHAT CHANGES versus upstream (and nothing else — no upstream code is touched):
#   + TableFormer v2 (`docling-project/TableFormerV2`, Apache-2.0) is downloaded with upstream's
#     own `docling-tools models download tableformerv2`. Requests select it with
#     `table_structure_preset=tableformer_v2` (os-ui's docling-client.ts).
#   - TableFormer v1 (`docling-project/docling-models`, CDLA-Permissive-2.0 — not on the licence
#     allowlist, owner decision O9) is deleted from the artifacts path.
#   + The HybridChunker's tokenizer (`sentence-transformers/all-MiniLM-L6-v2`, Apache-2.0,
#     tokenizer files only, pinned revision) is pre-downloaded into the Hugging Face cache, so
#     chunking never reaches the internet at runtime (the namespace denies egress).
#   HF_HUB_OFFLINE=1 makes any missing weight a loud error instead of a runtime download.
#   DOCLING_SERVE_LOAD_MODELS_AT_BOOT=false: upstream's boot warm-up builds the pipeline with the
#   DEFAULT options, whose table model is v1 — which is no longer in the image. The v2 pipeline
#   is built on the first conversion instead (os-ui always sends the v2 preset); a request that
#   asks for v1 fails loudly rather than loading CDLA-licensed weights.
#
# Licences of every weight in the image: components/docling/UPSTREAM.md.
# Build: docker build -t ghcr.io/data-masterclass/sovereign-os/docling:1.38.2-1 images/extensions/docling
ARG DOCLING_SERVE_IMAGE=quay.io/docling-project/docling-serve-cpu:v1.38.2@sha256:7a480a1604fa3b42efeddc7db9527690d9f9bc903226136013e2bfe6b1a4dfb0
FROM ${DOCLING_SERVE_IMAGE}

ARG MINILM_REPO=sentence-transformers/all-MiniLM-L6-v2
ARG MINILM_REVISION=1110a243fdf4706b3f48f1d95db1a4f5529b4d41

USER 1001

RUN set -eux; \
    HF_HUB_DOWNLOAD_TIMEOUT=90 HF_HUB_ETAG_TIMEOUT=90 \
      docling-tools models download -o "${DOCLING_SERVE_ARTIFACTS_PATH}" tableformerv2; \
    test -d "${DOCLING_SERVE_ARTIFACTS_PATH}/docling-project--TableFormerV2"; \
    rm -rf "${DOCLING_SERVE_ARTIFACTS_PATH}/docling-project--docling-models"; \
    python -c "from huggingface_hub import snapshot_download; snapshot_download('${MINILM_REPO}', revision='${MINILM_REVISION}', allow_patterns=['config.json','tokenizer.json','tokenizer_config.json','special_tokens_map.json','vocab.txt'])"; \
    chmod -R g=u "${DOCLING_SERVE_ARTIFACTS_PATH}" /opt/app-root/src/.cache/huggingface

ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    DOCLING_SERVE_LOAD_MODELS_AT_BOOT=false
