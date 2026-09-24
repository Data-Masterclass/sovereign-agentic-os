# Governed web_fetch tool — stdlib only, no deps. Base pinned by digest.
FROM python:3.12-slim@sha256:6c4dd321d176d61ea848dc8c73a4f7dbae8f70e0ee48bb411ea2f045b599fa8e

RUN useradd -u 1000 -m app
USER 1000
WORKDIR /app
COPY --chown=1000:1000 app.py /app/app.py

ENV PORT=8000
EXPOSE 8000
ENTRYPOINT ["python", "/app/app.py"]
