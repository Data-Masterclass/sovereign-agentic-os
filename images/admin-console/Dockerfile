# Admin console — stdlib Python + the docs baked in. Build context = repo root
# (so it can COPY docs/). Base pinned by digest.
FROM python:3.12-slim@sha256:6c4dd321d176d61ea848dc8c73a4f7dbae8f70e0ee48bb411ea2f045b599fa8e

RUN useradd -u 1000 -m app
# Vendored markdown renderer for offline client-side rendering (fetched at build).
ADD https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js /app/marked.min.js
COPY images/admin-console/app.py /app/app.py
COPY docs /docs
RUN chmod -R a+rX /app /docs
USER 1000

ENV PORT=8080 NAMESPACE=agentic-os DOCS_DIR=/docs
EXPOSE 8080
ENTRYPOINT ["python", "/app/app.py"]
