# Sovereign mock model — OpenAI-compatible stub (stdlib only, no deps).
# Pinned base by digest for supply-chain hygiene (python 3.12-slim).
FROM python:3.12-slim@sha256:6c4dd321d176d61ea848dc8c73a4f7dbae8f70e0ee48bb411ea2f045b599fa8e

# Non-root by default (matches the chart's secure pod defaults).
RUN useradd -u 1000 -m app
USER 1000
WORKDIR /app
COPY --chown=1000:1000 app.py /app/app.py

ENV PORT=8080 EMBED_DIM=384
EXPOSE 8080
ENTRYPOINT ["python", "/app/app.py"]
