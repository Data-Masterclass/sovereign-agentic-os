# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Scripted, request-counting OpenAI-compatible model stub for the kind acceptance harness.
# Same pinned base as images/base/mock-model (python 3.12-slim), stdlib only, non-root.
FROM python:3.12-slim@sha256:6c4dd321d176d61ea848dc8c73a4f7dbae8f70e0ee48bb411ea2f045b599fa8e
RUN useradd -u 1000 -m app
USER 1000
WORKDIR /app
COPY --chown=1000:1000 stub.py /app/stub.py
ENV PORT=8080 EMBED_DIM=384
EXPOSE 8080
ENTRYPOINT ["python", "/app/stub.py"]
