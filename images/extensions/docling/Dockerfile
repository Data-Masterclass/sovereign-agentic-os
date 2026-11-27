# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# docling — upstream docling-serve-cpu, with the model weights the OS's licence policy allows.
#
# WHAT CHANGES versus upstream (and nothing else — no upstream code is touched):
#   + TableFormer v2 (`docling-project/TableFormerV2`, Apache-2.0) at a PINNED revision, into the
#     folder upstream's TableStructureModelV2 reads (`docling-project--TableFormerV2`).
#   - TableFormer v1 (`docling-project/docling-models`, CDLA-Permissive-2.0 — not on the licence
#     allowlist, owner decision O9) is deleted from the artifacts path.
#   + The HybridChunker's tokenizer (`sentence-transformers/all-MiniLM-L6-v2`, Apache-2.0,
#     tokenizer files only, pinned revision) is pre-downloaded into the Hugging Face cache.
#   * The table model is chosen SERVER-SIDE with docling-serve's documented settings
#     (docs/configuration.md): DEFAULT_TABLE_STRUCTURE_PRESET=tableformer_v2 and
#     ALLOWED_TABLE_STRUCTURE_PRESETS=["tableformer_v2"]. So the boot warm-up
#     (LOAD_MODELS_AT_BOOT, upstream default true: "the models for the default options") loads
#     v2 and `/ready` answers 200 only once it has; a request for any v1 preset is refused.
#   * HF_HUB_OFFLINE=1: a missing weight is a loud error, never a runtime download.
#   * ENTRYPOINT guard (require-api-key.sh): refuses to start with an empty API key, because
#     upstream treats an empty DOCLING_SERVE_API_KEY as "no authentication".
#
# Licences of every weight in the image: components/docling/UPSTREAM.md. The build prints the
# model folder listing so the CI log shows exactly what shipped.
# Build: docker build -t ghcr.io/data-masterclass/sovereign-os/docling:1.38.2-1 images/extensions/docling
#
# BUILDING BEHIND A PROXY / FIREWALL / WITH A MIRROR (build time only — nothing here reaches the
# running image, which stays HF_HUB_OFFLINE):
#   --build-arg HTTPS_PROXY=http://proxy:3128 (and HTTP_PROXY / NO_PROXY) — Docker's predefined proxy
#       build args: every RUN sees them without an ARG line, and they are kept out of the image history.
#       huggingface_hub and its Xet client both honour them.
#   --build-arg HF_ENDPOINT=https://hf-mirror.example.com — a Hugging Face mirror (huggingface_hub's
#       HF_ENDPOINT). Empty (the default) = https://huggingface.co.
#       HF_ENDPOINT is an ARG, so its value is STORED IN THE IMAGE HISTORY: never put credentials in it.
#   --build-arg HF_HUB_DISABLE_XET=1 — plain HTTP downloads instead of the Xet protocol (a mirror or a
#       proxy that does not speak Xet).
# The hosts the download needs when nothing is mirrored (official list, docs/components/docling.md).
ARG DOCLING_SERVE_IMAGE=quay.io/docling-project/docling-serve-cpu:v1.38.2@sha256:7a480a1604fa3b42efeddc7db9527690d9f9bc903226136013e2bfe6b1a4dfb0
FROM ${DOCLING_SERVE_IMAGE}

ARG TABLEFORMER_V2_REPO=docling-project/TableFormerV2
ARG TABLEFORMER_V2_REVISION=e41ba5da7ef69004f4b329168791c2987abf917c
ARG MINILM_REPO=sentence-transformers/all-MiniLM-L6-v2
ARG MINILM_REVISION=1110a243fdf4706b3f48f1d95db1a4f5529b4d41
ARG HF_ENDPOINT=""
ARG HF_HUB_DISABLE_XET=""

USER 1001

# An EMPTY HF_ENDPOINT can make huggingface_hub use "" as its endpoint (a set-but-empty variable), so the RUN
# exports the mirror only when one was passed and unsets it otherwise; same for HF_HUB_DISABLE_XET.
RUN set -eux; \
    export HF_HUB_DOWNLOAD_TIMEOUT=90 HF_HUB_ETAG_TIMEOUT=90; \
    if [ -n "${HF_ENDPOINT}" ]; then export HF_ENDPOINT; echo "Hugging Face endpoint: ${HF_ENDPOINT}"; else unset HF_ENDPOINT; fi; \
    if [ -n "${HF_HUB_DISABLE_XET}" ]; then export HF_HUB_DISABLE_XET; else unset HF_HUB_DISABLE_XET; fi; \
    python -c "from huggingface_hub import snapshot_download; snapshot_download('${TABLEFORMER_V2_REPO}', revision='${TABLEFORMER_V2_REVISION}', local_dir='${DOCLING_SERVE_ARTIFACTS_PATH}/docling-project--TableFormerV2')"; \
    rm -rf "${DOCLING_SERVE_ARTIFACTS_PATH}/docling-project--TableFormerV2/.cache"; \
    rm -rf "${DOCLING_SERVE_ARTIFACTS_PATH}/docling-project--docling-models"; \
    python -c "from huggingface_hub import snapshot_download; snapshot_download('${MINILM_REPO}', revision='${MINILM_REVISION}', allow_patterns=['config.json','tokenizer.json','tokenizer_config.json','special_tokens_map.json','vocab.txt'])"; \
    chmod -R g=u "${DOCLING_SERVE_ARTIFACTS_PATH}" /opt/app-root/src/.cache/huggingface; \
    echo "=== model folders in ${DOCLING_SERVE_ARTIFACTS_PATH} ==="; \
    find "${DOCLING_SERVE_ARTIFACTS_PATH}" -maxdepth 3 -type d | sort; \
    du -sh "${DOCLING_SERVE_ARTIFACTS_PATH}"/* ; \
    echo "=== Hugging Face cache ==="; \
    find /opt/app-root/src/.cache/huggingface -maxdepth 4 | sort

COPY --chmod=0555 require-api-key.sh /usr/local/bin/require-api-key

ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    DOCLING_SERVE_DEFAULT_TABLE_STRUCTURE_PRESET=tableformer_v2 \
    DOCLING_SERVE_ALLOWED_TABLE_STRUCTURE_PRESETS='["tableformer_v2"]'

ENTRYPOINT ["/usr/local/bin/require-api-key", "container-entrypoint"]
CMD ["docling-serve", "run"]
