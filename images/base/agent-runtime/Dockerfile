# agent-runtime — shared IR interpreter for the Agents tab. Base pinned by digest
# (python 3.12-slim). Structure mirrors the sample/poet agents so the pip-install
# layer is cache-reused. Lean, non-root, readOnlyRootFilesystem-friendly.
FROM python:3.12-slim@sha256:6c4dd321d176d61ea848dc8c73a4f7dbae8f70e0ee48bb411ea2f045b599fa8e

WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

RUN useradd -u 1000 -m app
COPY --chown=1000:1000 interpreter.py /app/interpreter.py
COPY --chown=1000:1000 app.py /app/app.py
USER 1000

ENV PORT=8000 HOME=/tmp
EXPOSE 8000
ENTRYPOINT ["python", "/app/app.py"]
